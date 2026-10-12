#!/usr/bin/env node
/**
 * Single-instance dual-bot supervisor for XenonRP.
 *
 * Runs Xenon Guardian (@xenon/guardian-bot) and the website/FiveM integration
 * bot, Xenon Link (@xenon/link-bot), as two independent Node.js child
 * processes under one foreground process. No Docker, no process manager, no
 * extra dependency: Node built-ins only.
 *
 *   node scripts/start-bots.mjs                    run both bots
 *   node scripts/start-bots.mjs --check            validate config, print a report, exit
 *   node scripts/start-bots.mjs --check --verify-discord
 *                                                  also authenticate each token over REST
 *   node scripts/start-bots.mjs --only guardian    run one bot (staged rollout / rollback)
 *   --skip-ports                                   skip the loopback port probe (--check while the old bot runs)
 *
 * Isolation guarantees:
 * - Each child receives ONLY the keys its own env file declares for it, plus a
 *   small allowlist of non-secret system variables. The supervisor's own
 *   environment (panel variables, the other bot's secrets) is never forwarded.
 * - Cross-bot keys (LINK_* in the Guardian file, GUARDIAN_* in the integration
 *   file), equal tokens and equal application IDs abort before anything starts.
 * - Secret values are redacted from every log line of both children.
 *
 * Process safety:
 * - A lock file (.data/start-bots.lock) refuses a second supervisor and records
 *   child PIDs so a crashed supervisor's orphans are reaped on the next start.
 * - Children watch their IPC channel to the supervisor and stop themselves if
 *   it disappears (even SIGKILL), so they cannot outlive it.
 * - Guardian keeps its own single-instance lock (.data/discord-runtime.json.lock).
 * - With LINK_GATEWAY_MODE=relay Link opens no listening socket (it pulls worker
 *   requests through Core), so this lock is the only guard against a second
 *   Link: there is no gateway port to collide on. No host/port is validated or
 *   probed for it in that mode.
 */

import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** System variables a child may inherit. Nothing here is a credential. */
const SYSTEM_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'TZ',
  'LANG',
  'LC_ALL',
  'SystemRoot',
  'windir',
  'COMSPEC',
  'PATHEXT',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
];

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Last-resort IPC watchdog preloaded into every child: if the supervisor dies
 * (any signal, including SIGKILL) the IPC channel closes and the child begins
 * its normal SIGTERM shutdown. The channel is unref'd so it never keeps a
 * child alive on its own.
 */
const WATCHDOG_PRELOAD =
  'data:text/javascript,' +
  encodeURIComponent(
    "process.on('disconnect',()=>process.kill(process.pid,'SIGTERM'));process.channel?.unref();",
  );

const GATEWAY_MODES = ['http', 'relay'];

/** Child environment: the declared values plus the allow-listed system variables. */
function childEnv(values, hostEnv) {
  const env = { ...values };
  for (const key of SYSTEM_ENV_ALLOWLIST) {
    if (hostEnv[key] !== undefined && env[key] === undefined) env[key] = hostEnv[key];
  }
  return env;
}

/** Static description of the two bots. */
export const BOTS = [
  {
    name: 'guardian',
    pkg: '@xenon/guardian-bot',
    appDir: join(ROOT, 'apps', 'guardian-bot'),
    entry: 'src/main.ts',
    envFile: join(ROOT, '.env.guardian'),
    critical: true,
    heapMb: 1536,
    tokenKey: 'GUARDIAN_DISCORD_TOKEN',
    appIdKey: 'GUARDIAN_DISCORD_APPLICATION_ID',
    hostKey: 'GUARDIAN_HEALTH_HOST',
    portKey: 'GUARDIAN_HEALTH_PORT',
    defaultHost: '127.0.0.1',
    defaultPort: 8081,
    required: [
      'GUARDIAN_DISCORD_TOKEN',
      'GUARDIAN_DISCORD_APPLICATION_ID',
      'DISCORD_GUILD_ID',
      'DISCORD_INVITE_URL',
    ],
    optional: ['NEXT_PUBLIC_SITE_URL', 'GUARDIAN_HEALTH_HOST', 'GUARDIAN_HEALTH_PORT'],
    // Guardian's schema requires these literals.
    fixed: { NODE_ENV: 'production', LOG_LEVEL: 'info' },
    forbiddenPrefixes: ['LINK_', 'CORE_API_'],
    secretKeys: ['GUARDIAN_DISCORD_TOKEN'],
    listens: () => true,
  },
  {
    name: 'integration',
    pkg: '@xenon/link-bot',
    appDir: join(ROOT, 'apps', 'link-bot'),
    entry: 'src/main.ts',
    envFile: join(ROOT, '.env.integration'),
    critical: false,
    heapMb: 768,
    tokenKey: 'LINK_DISCORD_TOKEN',
    appIdKey: 'LINK_DISCORD_APPLICATION_ID',
    hostKey: 'LINK_GATEWAY_HOST',
    portKey: 'LINK_GATEWAY_PORT',
    defaultHost: '127.0.0.1',
    defaultPort: 8082,
    required: [
      'LINK_DISCORD_TOKEN',
      'LINK_DISCORD_APPLICATION_ID',
      'DISCORD_GUILD_ID',
      'NEXT_PUBLIC_SITE_URL',
      'CORE_API_URL',
      'LINK_CORE_SECRET',
      'LINK_GATEWAY_SECRET',
    ],
    optional: [
      'LINK_GATEWAY_MODE',
      'LINK_GATEWAY_HOST',
      'LINK_GATEWAY_PORT',
      'LINK_EVENTS_CHANNEL_ID',
      'LINK_STAFF_LOG_CHANNEL_ID',
      'LOG_LEVEL',
    ],
    fixed: { NODE_ENV: 'production' },
    forbiddenPrefixes: ['GUARDIAN_', 'DATABASE_', 'REDIS_', 'AUTH_'],
    secretKeys: ['LINK_DISCORD_TOKEN', 'LINK_CORE_SECRET', 'LINK_GATEWAY_SECRET'],
    // Relay: Link opens no listener and pulls worker requests through Core.
    modeKey: 'LINK_GATEWAY_MODE',
    listens: (values) => values.LINK_GATEWAY_MODE !== 'relay',
  },
];

const isBlank = (value) => value === undefined || value.trim() === '';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Read a bot's env file and build the child environment. Pure apart from the
 * file read; returns diagnostics instead of throwing. Messages contain key
 * names only, never values.
 */
export function loadBotConfig(bot, hostEnv = process.env) {
  const errors = [];
  const warnings = [];
  let file = {};

  if (!existsSync(bot.envFile)) {
    errors.push(`${bot.envFile} not found`);
    return { errors, warnings, env: {}, values: {} };
  }
  try {
    if (process.platform !== 'win32' && (statSync(bot.envFile).mode & 0o077) !== 0) {
      warnings.push(`${bot.envFile} is readable by group/others; run: chmod 600 ${bot.envFile}`);
    }
    file = parseEnv(readFileSync(bot.envFile, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    errors.push(`cannot parse ${bot.envFile}: ${error instanceof Error ? error.message : error}`);
    return { errors, warnings, env: {}, values: {} };
  }

  const allowed = new Set([...bot.required, ...bot.optional, ...Object.keys(bot.fixed)]);
  const values = {};
  for (const [key, raw] of Object.entries(file)) {
    if (bot.forbiddenPrefixes.some((prefix) => key.startsWith(prefix)) && !allowed.has(key)) {
      errors.push(
        `${key}: belongs to another service and must not appear in ${bot.name}'s env file`,
      );
    } else if (!allowed.has(key)) {
      warnings.push(`${key}: not used by ${bot.name}; ignored`);
    } else if (!isBlank(raw)) {
      values[key] = raw.trim();
    }
  }

  for (const [key, literal] of Object.entries(bot.fixed)) {
    if (values[key] !== undefined && values[key] !== literal) {
      errors.push(`${key}: ${bot.name} requires ${literal}`);
    }
    values[key] = literal;
  }
  for (const key of bot.required) {
    if (values[key] === undefined) errors.push(`${key}: required and missing or blank`);
  }
  if (bot.modeKey !== undefined && !GATEWAY_MODES.includes(values[bot.modeKey] ?? 'http')) {
    errors.push(`${bot.modeKey}: must be http or relay`);
  }

  // In relay mode Link opens no socket: there is no host or port to check.
  if (!bot.listens(values)) {
    return { errors, warnings, env: childEnv(values, hostEnv), values, host: null, port: null };
  }
  const host = values[bot.hostKey] ?? bot.defaultHost;
  if (!LOOPBACK_HOSTS.has(host)) {
    errors.push(`${bot.hostKey}: must be loopback (127.0.0.1); public listeners are not allowed`);
  }
  const port = Number(values[bot.portKey] ?? bot.defaultPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    errors.push(`${bot.portKey}: must be a port number`);
  }

  return { errors, warnings, env: childEnv(values, hostEnv), values, host, port };
}

/** The bot user ID is the first dot-separated segment of a bot token (base64). */
export function tokenUserId(token) {
  const segment = token.split('.')[0] ?? '';
  const decoded = Buffer.from(segment, 'base64').toString('utf8');
  return /^\d{17,20}$/.test(decoded) ? decoded : null;
}

/** Cross-bot checks that no single bot's env file can perform on its own. */
export function crossCheck(configs) {
  const errors = [];
  const [first, second] = configs;
  if (!first || !second) return errors;
  const a = first.bot;
  const b = second.bot;
  const av = first.cfg.values;
  const bv = second.cfg.values;

  if (av[a.tokenKey] && av[a.tokenKey] === bv[b.tokenKey]) {
    errors.push(
      `${a.tokenKey} and ${b.tokenKey} are identical; the bots need separate Discord applications`,
    );
  }
  if (av[a.appIdKey] && av[a.appIdKey] === bv[b.appIdKey]) {
    errors.push(
      `${a.appIdKey} and ${b.appIdKey} are identical; the bots need separate Discord applications`,
    );
  }
  const sameListener =
    first.cfg.host !== null &&
    second.cfg.host !== null &&
    first.cfg.host === second.cfg.host &&
    first.cfg.port === second.cfg.port;
  if (sameListener) {
    errors.push(`${a.portKey} and ${b.portKey} resolve to the same host:port`);
  }
  for (const [owner, other] of [
    [first, second],
    [second, first],
  ]) {
    const token = owner.cfg.values[owner.bot.tokenKey];
    const id = token ? tokenUserId(token) : null;
    if (id !== null && id === other.cfg.values[other.bot.appIdKey]) {
      errors.push(
        `${owner.bot.tokenKey} belongs to the application configured as ${other.bot.appIdKey}`,
      );
    }
  }
  return errors;
}

/** Per-bot token sanity: the token's embedded user ID should match its application ID. */
export function tokenWarnings(bot, values) {
  const token = values[bot.tokenKey];
  const id = token ? tokenUserId(token) : null;
  if (token && id === null) return [`${bot.tokenKey}: does not look like a Discord bot token`];
  if (id !== null && values[bot.appIdKey] && id !== values[bot.appIdKey]) {
    return [`${bot.tokenKey}: token's user ID does not match ${bot.appIdKey}`];
  }
  return [];
}

/** Resolves true when host:port can be bound right now. */
export function portFree(host, port) {
  return new Promise((resolvePort) => {
    const probe = createServer();
    probe.once('error', () => resolvePort(false));
    probe.listen(port, host, () => probe.close(() => resolvePort(true)));
  });
}

/** Authenticate a token over REST (no gateway session) and confirm its identity. */
export async function verifyDiscord(bot, values, fetchImpl = fetch) {
  try {
    const response = await fetchImpl('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${values[bot.tokenKey]}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200)
      return `HTTP ${response.status} (token rejected or Discord unreachable)`;
    const me = await response.json();
    if (me.bot !== true) return 'token does not belong to a bot user';
    if (me.id !== values[bot.appIdKey])
      return `authenticated as a different application than ${bot.appIdKey}`;
    return null;
  } catch (error) {
    return `request failed: ${error instanceof Error ? error.name : 'error'}`;
  }
}

/** Run every preflight check. Returns { ok, configs, report[] }. */
export async function preflight(
  bots,
  { probePorts = true, verify = false, hostEnv = process.env, fetchImpl } = {},
) {
  const report = [];
  const configs = bots.map((bot) => ({ bot, cfg: loadBotConfig(bot, hostEnv) }));
  let ok = true;
  const fail = (scope, message) => {
    ok = false;
    report.push(`FAIL  ${scope}: ${message}`);
  };

  for (const { bot, cfg } of configs) {
    cfg.errors.forEach((message) => fail(bot.name, message));
    cfg.warnings.forEach((message) => report.push(`WARN  ${bot.name}: ${message}`));
    if (cfg.errors.length > 0) continue;
    tokenWarnings(bot, cfg.values).forEach((message) =>
      report.push(`WARN  ${bot.name}: ${message}`),
    );
    if (!existsSync(join(bot.appDir, bot.entry)))
      fail(bot.name, `entrypoint ${bot.entry} missing in ${bot.pkg}`);
    if (!existsSync(join(bot.appDir, 'node_modules', 'tsx'))) {
      fail(
        bot.name,
        `tsx not installed for ${bot.pkg}; run: npx --yes pnpm@10.26.2 install --frozen-lockfile`,
      );
    }
  }
  if (configs.every(({ cfg }) => cfg.errors.length === 0)) {
    crossCheck(configs).forEach((message) => fail('cross-check', message));
  }
  if (probePorts) {
    for (const { bot, cfg } of configs) {
      if (cfg.errors.length === 0 && cfg.host !== null && !(await portFree(cfg.host, cfg.port))) {
        fail(
          bot.name,
          `${cfg.host}:${cfg.port} is in use (is another copy or the old single-bot process still running?)`,
        );
      }
    }
  }
  if (verify && ok) {
    for (const { bot, cfg } of configs) {
      const problem = await verifyDiscord(bot, cfg.values, fetchImpl);
      if (problem) fail(bot.name, `Discord authentication: ${problem}`);
      else report.push(`OK    ${bot.name}: Discord authentication succeeded as ${bot.appIdKey}`);
    }
  }
  if (ok) report.push(`OK    ${bots.map((bot) => bot.name).join(' + ')}: configuration valid`);
  return { ok, configs, report };
}

// ---------------------------------------------------------------------------
// Process bookkeeping
// ---------------------------------------------------------------------------

/** Process start time in clock ticks (Linux only), used to defeat PID reuse. */
export function processStartTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

function isAlive(pid, ticks) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code === 'EPERM';
  }
  // On Linux a different start time means the PID was reused by another process.
  const current = processStartTicks(pid);
  return ticks == null || current == null || current === ticks;
}

async function reap(pid, ticks, label, log) {
  if (!isAlive(pid, ticks)) return;
  if (ticks == null || processStartTicks(pid) == null) {
    log(`WARN  cannot verify leftover ${label} (pid ${pid}) on this platform; not terminating it`);
    return;
  }
  log(`reaping orphaned ${label} (pid ${pid}) from a previous supervisor`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  for (let i = 0; i < 100 && isAlive(pid, ticks); i += 1)
    await new Promise((r) => setTimeout(r, 100));
  if (isAlive(pid, ticks)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

export class SupervisorLock {
  constructor(path, log) {
    this.path = path;
    this.log = log;
    this.state = { pid: process.pid, ticks: processStartTicks(process.pid), children: {} };
    this.held = false;
  }

  async acquire() {
    mkdirSync(dirname(this.path), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        closeSync(openSync(this.path, 'wx'));
        this.held = true;
        this.flush();
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      let previous = null;
      try {
        previous = JSON.parse(readFileSync(this.path, 'utf8'));
      } catch {
        /* unreadable lock: treated as stale below only if no live pid can be read */
      }
      if (previous && previous.pid !== process.pid && isAlive(previous.pid, previous.ticks)) {
        throw new Error(
          `another supervisor is already running (pid ${previous.pid}); refusing to start a duplicate`,
        );
      }
      if (!previous) {
        throw new Error(
          `${this.path} exists but is unreadable; remove it manually once no supervisor runs`,
        );
      }
      for (const [name, child] of Object.entries(previous.children ?? {})) {
        await reap(child.pid, child.ticks, name, this.log);
      }
      this.log('removed stale supervisor lock');
      unlinkSync(this.path);
    }
    throw new Error('could not acquire the supervisor lock');
  }

  flush() {
    if (this.held) writeFileSync(this.path, JSON.stringify(this.state));
  }

  setChild(name, pid) {
    if (pid === undefined) delete this.state.children[name];
    else this.state.children[name] = { pid, ticks: processStartTicks(pid) };
    this.flush();
  }

  release() {
    if (!this.held) return;
    this.held = false;
    try {
      unlinkSync(this.path);
    } catch {
      /* already removed */
    }
  }
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

const BACKOFF_START_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
const STABLE_AFTER_MS = 60_000;
const CRASH_WINDOW_MS = 10 * 60_000;
const CRASH_BUDGET = 8;
const SHUTDOWN_GRACE_MS = 25_000;

/**
 * Run the given preflighted bots until a signal arrives or a critical bot
 * exhausts its crash budget. Resolves with the intended process exit code.
 *
 * `options.timing` and `options.spawnArgs` exist so tests can run fast with
 * fake bots; production passes neither.
 */
export function supervise(configs, options = {}) {
  const {
    lockPath = join(ROOT, '.data', 'start-bots.lock'),
    out = (line) => process.stdout.write(`${line}\n`),
    timing = {},
    spawnArgs = (bot) => [
      `--max-old-space-size=${bot.heapMb}`,
      '--import',
      WATCHDOG_PRELOAD,
      '--import',
      'tsx',
      bot.entry,
    ],
  } = options;
  const t = {
    backoffStart: BACKOFF_START_MS,
    backoffMax: BACKOFF_MAX_MS,
    stableAfter: STABLE_AFTER_MS,
    crashWindow: CRASH_WINDOW_MS,
    crashBudget: CRASH_BUDGET,
    grace: SHUTDOWN_GRACE_MS,
    ...timing,
  };

  const secrets = [
    ...new Set(
      configs.flatMap(({ bot, cfg }) =>
        bot.secretKeys.map((key) => cfg.values[key]).filter((value) => value && value.length >= 8),
      ),
    ),
  ].sort((x, y) => y.length - x.length);
  const redact = (line) =>
    secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), line);
  const stamp = () => new Date().toISOString();
  const logFor = (label) => (line) => out(`${stamp()} [${label}] ${redact(line)}`);
  const log = logFor('supervisor');

  const lock = new SupervisorLock(lockPath, log);
  const runs = configs.map(({ bot, cfg }) => ({
    bot,
    cfg,
    emit: logFor(bot.name),
    child: null,
    backoff: t.backoffStart,
    crashes: [],
    timer: null,
    startedAt: 0,
    gaveUp: false,
    exited: Promise.resolve(),
  }));

  let stopping = false;
  let exitCode = 0;
  let finish;
  const done = new Promise((resolveDone) => {
    finish = resolveDone;
  });

  function launch(run) {
    run.timer = null;
    if (stopping) return;
    const { bot, cfg } = run;
    // The child environment is exactly cfg.env: nothing else is inherited.
    const child = spawn(process.execPath, spawnArgs(bot), {
      cwd: bot.appDir,
      env: cfg.env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    run.child = child;
    run.startedAt = Date.now();
    lock.setChild(bot.name, child.pid);
    run.emit(`started (pid ${child.pid}, ${bot.pkg})`);
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on('line', run.emit);
    }
    run.exited = new Promise((resolveExit) => {
      let handled = false;
      const onEnd = (code, signal, spawnError) => {
        if (handled) return;
        handled = true;
        run.child = null;
        lock.setChild(bot.name, undefined);
        resolveExit();
        onChildExit(run, code, signal, spawnError);
      };
      child.once('error', (error) => onEnd(null, null, error));
      child.once('exit', (code, signal) => onEnd(code, signal));
    });
  }

  function onChildExit(run, code, signal, spawnError) {
    const reason = spawnError
      ? `failed to spawn: ${spawnError.code ?? spawnError.name}`
      : `exited (${signal ? `signal ${signal}` : `code ${code}`})`;
    if (stopping) {
      run.emit(`stopped: ${reason}`);
      return;
    }
    const now = Date.now();
    if (now - run.startedAt >= t.stableAfter) {
      run.backoff = t.backoffStart;
      run.crashes = [];
    }
    run.crashes = run.crashes.filter((at) => now - at < t.crashWindow);
    run.crashes.push(now);

    if (run.crashes.length >= t.crashBudget) {
      run.gaveUp = true;
      log(
        `ERROR ${run.bot.name} ${reason}; ${run.crashes.length} failures in ${Math.round(t.crashWindow / 60000)} min, giving up`,
      );
      if (run.bot.critical || runs.every((other) => other.gaveUp)) {
        exitCode = 1;
        void shutdown(`${run.bot.name} unrecoverable`);
      } else {
        log(
          `WARN  continuing without ${run.bot.name}; ${runs
            .filter((r) => !r.gaveUp)
            .map((r) => r.bot.name)
            .join(', ')} stays up`,
        );
        exitCode = 1;
      }
      return;
    }
    log(`WARN  ${run.bot.name} ${reason}; restarting in ${Math.round(run.backoff / 1000)}s`);
    run.timer = setTimeout(() => launch(run), run.backoff);
    run.backoff = Math.min(run.backoff * 2, t.backoffMax);
  }

  async function shutdown(cause) {
    if (stopping) return;
    stopping = true;
    log(`shutting down (${cause})`);
    const live = runs.filter((run) => run.child);
    for (const run of runs) clearTimeout(run.timer);
    for (const run of live) run.child.kill('SIGTERM');
    const killTimer = setTimeout(() => {
      for (const run of runs) {
        if (run.child) {
          log(`WARN  ${run.bot.name} ignored SIGTERM for ${Math.round(t.grace / 1000)}s; killing`);
          run.child.kill('SIGKILL');
        }
      }
    }, t.grace);
    await Promise.all(live.map((run) => run.exited));
    clearTimeout(killTimer);
    lock.release();
    log('stopped');
    finish(exitCode);
  }

  const handlers = new Map();
  const onSignal = (signal) => {
    if (stopping) {
      // Second signal: stop waiting politely.
      for (const run of runs) run.child?.kill('SIGKILL');
      return;
    }
    exitCode = 0;
    void shutdown(signal);
  };
  const onFatal = (error) => {
    log(`ERROR supervisor crashed: ${error instanceof Error ? error.name : 'error'}`);
    exitCode = 1;
    void shutdown('internal error');
  };
  const onExit = () => {
    for (const run of runs) run.child?.kill('SIGKILL');
    lock.release();
  };

  const started = (async () => {
    await lock.acquire();
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handler = () => onSignal(signal);
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    process.on('uncaughtException', onFatal);
    process.on('unhandledRejection', onFatal);
    process.on('exit', onExit);
    log(
      `supervising ${runs.map((run) => run.bot.name).join(' + ')} (pid ${process.pid}, node ${process.version})`,
    );
    for (const run of runs) launch(run);
  })();

  const cleanup = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    process.off('uncaughtException', onFatal);
    process.off('unhandledRejection', onFatal);
    process.off('exit', onExit);
  };

  return {
    /** Resolves to the exit code once everything has stopped. */
    result: started.then(() => done).finally(cleanup),
    stop: (cause = 'stop requested') => shutdown(cause),
    children: () => Object.fromEntries(runs.map((run) => [run.bot.name, run.child?.pid ?? null])),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  const flags = new Set(argv.filter((arg) => arg.startsWith('--') && arg !== '--only'));
  const onlyIndex = argv.indexOf('--only');
  const only = onlyIndex >= 0 ? argv[onlyIndex + 1] : null;
  const known = new Set(['--check', '--verify-discord', '--skip-ports', '--only']);
  const unknown = argv.filter((arg) => arg.startsWith('--') && !known.has(arg));
  if (unknown.length > 0 || (only !== null && !BOTS.some((bot) => bot.name === only))) {
    process.stderr.write(
      `usage: node scripts/start-bots.mjs [--check] [--verify-discord] [--skip-ports] [--only guardian|integration]\n`,
    );
    return 2;
  }
  if (Number(process.versions.node.split('.')[0]) < 24) {
    process.stderr.write(`Node.js >=24 required (found ${process.version})\n`);
    return 2;
  }

  const bots = only ? BOTS.filter((bot) => bot.name === only) : BOTS;
  const checkOnly = flags.has('--check');
  const result = await preflight(bots, {
    probePorts: !flags.has('--skip-ports'),
    verify: flags.has('--verify-discord'),
  });
  for (const line of result.report) process.stdout.write(`${line}\n`);
  if (!result.ok) return 1;
  if (checkOnly) return 0;

  const supervisor = supervise(result.configs);
  return supervisor.result.catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    return 1;
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then((code) => {
    process.exitCode = code;
  });
}
