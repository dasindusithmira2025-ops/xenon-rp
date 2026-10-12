import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  BOTS,
  crossCheck,
  loadBotConfig,
  portFree,
  preflight,
  supervise,
  SupervisorLock,
  tokenUserId,
} from './start-bots.mjs';

const SCRIPT_URL = pathToFileURL(join(import.meta.dirname, 'start-bots.mjs')).href;
const work = mkdtempSync(join(tmpdir(), 'xenon-bots-'));
after(() => rmSync(work, { recursive: true, force: true }));

const GUARDIAN_ID = '111111111111111111';
const LINK_ID = '222222222222222222';
const tok = (id, tail) => `${Buffer.from(id).toString('base64')}.AbCdEf.${tail}`;
const GUARDIAN_TOKEN = tok(GUARDIAN_ID, 'guardian-secret-tail-0000000000');
const LINK_TOKEN = tok(LINK_ID, 'link-secret-tail-1111111111111');

function envFile(name, lines) {
  const path = join(work, name);
  writeFileSync(path, lines.join('\n'));
  return path;
}

function realBots(overrides = {}) {
  const guardianFile = envFile(`g-${Math.random()}.env`, [
    `GUARDIAN_DISCORD_TOKEN=${overrides.guardianToken ?? GUARDIAN_TOKEN}`,
    `GUARDIAN_DISCORD_APPLICATION_ID=${overrides.guardianId ?? GUARDIAN_ID}`,
    'DISCORD_GUILD_ID=333333333333333333',
    'DISCORD_INVITE_URL=https://discord.gg/x',
    'NODE_ENV=production',
    'LOG_LEVEL=info',
    ...(overrides.guardianExtra ?? []),
  ]);
  const linkFile = envFile(`l-${Math.random()}.env`, [
    `LINK_DISCORD_TOKEN=${overrides.linkToken ?? LINK_TOKEN}`,
    `LINK_DISCORD_APPLICATION_ID=${overrides.linkId ?? LINK_ID}`,
    'DISCORD_GUILD_ID=333333333333333333',
    'NEXT_PUBLIC_SITE_URL=https://example.test',
    'CORE_API_URL=https://core.example.test',
    `LINK_CORE_SECRET=${'c'.repeat(40)}`,
    `LINK_GATEWAY_SECRET=${'g'.repeat(40)}`,
    ...(overrides.linkExtra ?? []),
  ]);
  return [
    { ...BOTS[0], envFile: guardianFile },
    { ...BOTS[1], envFile: linkFile },
  ];
}

describe('configuration isolation', () => {
  test('child env holds only its own keys plus system allowlist', () => {
    const [guardian, link] = realBots();
    const host = {
      PATH: '/bin',
      LINK_DISCORD_TOKEN: 'host-leak',
      GUARDIAN_DISCORD_TOKEN: 'host-leak',
      DATABASE_URL: 'postgres://leak',
    };
    const g = loadBotConfig(guardian, host);
    const l = loadBotConfig(link, host);
    assert.deepEqual(g.errors, []);
    assert.deepEqual(l.errors, []);
    assert.equal(g.env.GUARDIAN_DISCORD_TOKEN, GUARDIAN_TOKEN);
    assert.equal(g.env.PATH, '/bin');
    assert.equal(g.env.LINK_DISCORD_TOKEN, undefined);
    assert.equal(g.env.LINK_CORE_SECRET, undefined);
    assert.equal(g.env.DATABASE_URL, undefined);
    assert.equal(l.env.LINK_DISCORD_TOKEN, LINK_TOKEN);
    assert.equal(l.env.GUARDIAN_DISCORD_TOKEN, undefined);
    assert.equal(l.env.DATABASE_URL, undefined);
    assert.equal(g.env.NODE_ENV, 'production');
    assert.equal(g.env.LOG_LEVEL, 'info');
  });

  test("the other bot's keys in an env file are rejected without echoing values", () => {
    const [guardian, link] = realBots({
      guardianExtra: ['LINK_DISCORD_TOKEN=sup3r-secret-value-xyz'],
      linkExtra: [
        'GUARDIAN_DISCORD_TOKEN=sup3r-secret-value-abc',
        'DATABASE_URL=postgres://u:p@h/db',
      ],
    });
    const g = loadBotConfig(guardian);
    const l = loadBotConfig(link);
    assert.ok(g.errors.some((e) => e.startsWith('LINK_DISCORD_TOKEN')));
    assert.ok(l.errors.some((e) => e.startsWith('GUARDIAN_DISCORD_TOKEN')));
    assert.ok(l.errors.some((e) => e.startsWith('DATABASE_URL')));
    assert.ok(![...g.errors, ...l.errors].join('\n').includes('sup3r-secret'));
  });

  test('missing required keys, non-literal NODE_ENV and public bind hosts are errors', () => {
    const [guardian, link] = realBots({ linkExtra: ['LINK_GATEWAY_HOST=0.0.0.0'] });
    writeFileSync(guardian.envFile, 'NODE_ENV=development\nGUARDIAN_DISCORD_TOKEN=abc\n');
    const g = loadBotConfig(guardian);
    assert.ok(g.errors.some((e) => e.startsWith('NODE_ENV')));
    assert.ok(g.errors.some((e) => e.startsWith('GUARDIAN_DISCORD_APPLICATION_ID')));
    assert.ok(loadBotConfig(link).errors.some((e) => e.startsWith('LINK_GATEWAY_HOST')));
  });

  test('identical tokens, identical application ids, swapped identities and equal ports fail the cross-check', () => {
    const run = (o) => {
      const bots = realBots(o);
      return crossCheck(bots.map((bot) => ({ bot, cfg: loadBotConfig(bot) })));
    };
    assert.deepEqual(run({}), []);
    assert.ok(run({ linkToken: GUARDIAN_TOKEN }).some((e) => e.includes('identical')));
    assert.ok(run({ linkId: GUARDIAN_ID }).some((e) => e.includes('identical')));
    assert.ok(
      run({ linkToken: tok(GUARDIAN_ID, 'x'.repeat(30)) }).some((e) =>
        e.includes('belongs to the application'),
      ),
    );
    assert.ok(
      run({ guardianExtra: ['GUARDIAN_HEALTH_PORT=8082'] }).some((e) =>
        e.includes('same host:port'),
      ),
    );
  });

  test('relay mode skips host/port validation, the port clash and the port probe, and forwards the mode', async () => {
    const [guardian, link] = realBots({
      guardianExtra: ['GUARDIAN_HEALTH_PORT=8082'],
      // Would be rejected in http mode (public bind) and clash with Guardian's port.
      linkExtra: ['LINK_GATEWAY_MODE=relay', 'LINK_GATEWAY_HOST=0.0.0.0', 'LINK_GATEWAY_PORT=8082'],
    });
    const l = loadBotConfig(link, {});
    assert.deepEqual(l.errors, []);
    assert.equal(l.host, null);
    assert.equal(l.port, null);
    assert.equal(l.env.LINK_GATEWAY_MODE, 'relay');
    assert.deepEqual(
      crossCheck([
        { bot: guardian, cfg: loadBotConfig(guardian, {}) },
        { bot: link, cfg: l },
      ]),
      [],
    );

    // Even with Link's would-be port occupied, preflight must not probe it.
    const { createServer } = await import('node:net');
    const server = createServer().listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const busy = String(server.address().port);
    const [relayGuardian, relayLink] = realBots({
      guardianExtra: [`GUARDIAN_HEALTH_PORT=${busy}`],
      linkExtra: ['LINK_GATEWAY_MODE=relay', `LINK_GATEWAY_PORT=${busy}`],
    });
    const fakeDir = join(work, 'relay-app');
    mkdirSync(join(fakeDir, 'node_modules', 'tsx'), { recursive: true });
    mkdirSync(join(fakeDir, 'src'), { recursive: true });
    writeFileSync(join(fakeDir, 'src', 'main.ts'), '');
    const staged = [relayGuardian, relayLink].map((bot) => ({ ...bot, appDir: fakeDir }));
    const result = await preflight(staged, { probePorts: true });
    server.close();
    // Guardian's port is genuinely busy and is probed; Link's is not (relay opens no socket).
    const text = result.report.join('\n');
    assert.match(text, /FAIL\s+guardian: .* is in use/);
    assert.doesNotMatch(text, /FAIL\s+integration/);
  });

  test('http mode (explicit or default) still validates host and port and forwards the mode', () => {
    const [, link] = realBots({
      linkExtra: ['LINK_GATEWAY_MODE=http', 'LINK_GATEWAY_HOST=0.0.0.0'],
    });
    const l = loadBotConfig(link, {});
    assert.ok(l.errors.some((e) => e.startsWith('LINK_GATEWAY_HOST')));
    const [, plain] = realBots();
    const p = loadBotConfig(plain, {});
    assert.equal(p.host, '127.0.0.1');
    assert.equal(p.port, 8082);
    assert.equal(p.env.LINK_GATEWAY_MODE, undefined);
  });

  test('an invalid LINK_GATEWAY_MODE is an error', () => {
    const [, link] = realBots({ linkExtra: ['LINK_GATEWAY_MODE=both'] });
    const l = loadBotConfig(link, {});
    assert.ok(l.errors.includes('LINK_GATEWAY_MODE: must be http or relay'));
  });

  test('tokenUserId decodes the bot id segment', () => {
    assert.equal(tokenUserId(GUARDIAN_TOKEN), GUARDIAN_ID);
    assert.equal(tokenUserId('not-a-token'), null);
  });

  test('preflight reports key names only and never a secret', async () => {
    const bots = realBots({ linkExtra: ['GUARDIAN_DISCORD_TOKEN=leaky-leaky-leaky'] });
    const result = await preflight(bots, { probePorts: false });
    assert.equal(result.ok, false);
    const text = result.report.join('\n');
    assert.ok(text.includes('GUARDIAN_DISCORD_TOKEN'));
    assert.ok(
      !text.includes('leaky') && !text.includes(GUARDIAN_TOKEN) && !text.includes(LINK_TOKEN),
    );
  });

  test('preflight --verify-discord authenticates each token and checks identity (stubbed REST)', async () => {
    const bots = realBots();
    // Preflight also needs tsx + entrypoints; use fake dirs.
    const fakeDir = join(work, 'verify-app');
    mkdirSync(join(fakeDir, 'node_modules', 'tsx'), { recursive: true });
    mkdirSync(join(fakeDir, 'src'), { recursive: true });
    writeFileSync(join(fakeDir, 'src', 'main.ts'), '');
    const staged = bots.map((bot) => ({ ...bot, appDir: fakeDir }));
    const calls = [];
    const fetchImpl = async (_url, init) => {
      const token = init.headers.Authorization.replace('Bot ', '');
      calls.push(token);
      const id = token === GUARDIAN_TOKEN ? GUARDIAN_ID : LINK_ID;
      return { status: 200, json: async () => ({ id, bot: true }) };
    };
    const ok = await preflight(staged, { probePorts: false, verify: true, fetchImpl });
    assert.equal(ok.ok, true, ok.report.join('\n'));
    assert.deepEqual(calls.sort(), [GUARDIAN_TOKEN, LINK_TOKEN].sort());
    const rejected = await preflight(staged, {
      probePorts: false,
      verify: true,
      fetchImpl: async () => ({ status: 401, json: async () => ({}) }),
    });
    assert.equal(rejected.ok, false);
  });

  test('portFree detects a bound loopback port', async () => {
    const { createServer } = await import('node:net');
    const server = createServer().listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    assert.equal(await portFree('127.0.0.1', server.address().port), false);
    server.close();
  });
});

// --- supervision with fake bots -------------------------------------------

const FAKE_BOT = `
const mode = process.env.FAKE_MODE ?? 'run';
console.log('boot keys=' + Object.keys(process.env).filter((k) => /TOKEN|SECRET|FAKE|NODE_ENV/.test(k)).sort().join(','));
console.log('leak-test ' + (process.env.FAKE_TOKEN ?? ''));
process.on('SIGTERM', () => { console.log('got SIGTERM'); process.exit(0); });
if (mode === 'crash') setTimeout(() => process.exit(3), 30);
else setInterval(() => {}, 1000);
`;

function fakeBots({ guardianMode = 'run', integrationMode = 'run' } = {}) {
  const dir = mkdtempSync(join(work, 'fake-'));
  writeFileSync(join(dir, 'main.mjs'), FAKE_BOT);
  const make = (bot, mode, token, extra) => ({
    ...bot,
    appDir: dir,
    entry: 'main.mjs',
    envFile: envFile(`${bot.name}-${Math.random()}.env`, [
      `${bot.tokenKey}=${token}`,
      ...bot.required
        .filter((k) => k !== bot.tokenKey)
        .map((k) => `${k}=${k.endsWith('_ID') ? '444444444444444444' : 'v'.repeat(40)}`),
      ...extra,
    ]),
  });
  const bots = [
    make(BOTS[0], guardianMode, GUARDIAN_TOKEN, []),
    make(BOTS[1], integrationMode, LINK_TOKEN, []),
  ];
  const configs = bots.map((bot) => ({ bot, cfg: loadBotConfig(bot, {}) }));
  // FAKE_* are test controls injected after validation, only into the child env.
  configs[0].cfg.env.FAKE_MODE = guardianMode;
  configs[0].cfg.env.FAKE_TOKEN = GUARDIAN_TOKEN;
  configs[1].cfg.env.FAKE_MODE = integrationMode;
  configs[1].cfg.env.FAKE_TOKEN = LINK_TOKEN;
  return { dir, configs };
}

const FAST = {
  backoffStart: 20,
  backoffMax: 40,
  grace: 2000,
  crashBudget: 3,
  crashWindow: 60_000,
  stableAfter: 60_000,
};
const fakeArgs = (bot) => [bot.entry];

function collector() {
  const lines = [];
  return { lines, out: (line) => lines.push(line) };
}
const until = async (predicate, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out waiting for condition');
};

describe('supervision', () => {
  test('runs both children concurrently with labelled logs, redaction and isolated env', async () => {
    const { configs } = fakeBots();
    const { lines, out } = collector();
    const lockPath = join(work, `lock-${Math.random()}`);
    const sup = supervise(configs, { out, lockPath, timing: FAST, spawnArgs: fakeArgs });
    await until(() => lines.filter((l) => l.includes('boot keys=')).length === 2);
    const pids = sup.children();
    assert.ok(pids.guardian && pids.integration && pids.guardian !== pids.integration);

    const guardianBoot = lines.find((l) => l.includes('[guardian]') && l.includes('boot keys='));
    const integrationBoot = lines.find(
      (l) => l.includes('[integration]') && l.includes('boot keys='),
    );
    assert.match(guardianBoot, /GUARDIAN_DISCORD_TOKEN/);
    assert.doesNotMatch(guardianBoot, /LINK_/);
    assert.match(integrationBoot, /LINK_CORE_SECRET.*LINK_DISCORD_TOKEN|LINK_DISCORD_TOKEN/);
    assert.doesNotMatch(integrationBoot, /GUARDIAN_/);

    await until(() => lines.filter((l) => l.includes('leak-test')).length === 2);
    const all = lines.join('\n');
    assert.ok(
      !all.includes(GUARDIAN_TOKEN) && !all.includes(LINK_TOKEN),
      'tokens must be redacted',
    );
    assert.ok(all.includes('[redacted]'));

    assert.ok(existsSync(lockPath));
    await sup.stop('test');
    assert.equal(await sup.result, 0);
    if (process.platform !== 'win32') {
      // Windows has no graceful SIGTERM: child.kill() terminates immediately.
      assert.ok(lines.some((l) => l.includes('[guardian] got SIGTERM')));
      assert.ok(lines.some((l) => l.includes('[integration] got SIGTERM')));
    }
    assert.ok(!existsSync(lockPath), 'lock released');
    assert.equal(sup.children().guardian, null);
  });

  test('a crashing child restarts with backoff while the other keeps running', async () => {
    const { configs } = fakeBots({ integrationMode: 'crash' });
    const { lines, out } = collector();
    const sup = supervise(configs, {
      out,
      lockPath: join(work, `lock-${Math.random()}`),
      timing: { ...FAST, crashBudget: 100 },
      spawnArgs: fakeArgs,
    });
    await until(() => lines.filter((l) => l.includes('[integration] started')).length >= 3);
    assert.ok(
      lines.some((l) => l.includes('[supervisor] WARN  integration exited (code 3); restarting')),
    );
    assert.equal(
      lines.filter((l) => l.includes('[guardian] started')).length,
      1,
      'guardian not restarted',
    );
    await sup.stop('test');
    await sup.result;
  });

  test('integration exhausting its crash budget leaves Guardian running; exit code is 1 on stop-less failure', async () => {
    const { configs } = fakeBots({ integrationMode: 'crash' });
    const { lines, out } = collector();
    const sup = supervise(configs, {
      out,
      lockPath: join(work, `lock-${Math.random()}`),
      timing: FAST,
      spawnArgs: fakeArgs,
    });
    await until(() => lines.some((l) => l.includes('giving up')));
    assert.ok(lines.some((l) => l.includes('continuing without integration')));
    assert.ok(sup.children().guardian, 'guardian still running');
    await sup.stop('test');
    await sup.result;
  });

  test('a critical Guardian exhausting its budget shuts everything down with exit 1', async () => {
    const { configs } = fakeBots({ guardianMode: 'crash' });
    const { out } = collector();
    const sup = supervise(configs, {
      out,
      lockPath: join(work, `lock-${Math.random()}`),
      timing: FAST,
      spawnArgs: fakeArgs,
    });
    assert.equal(await sup.result, 1);
    assert.deepEqual(sup.children(), { guardian: null, integration: null });
  });

  test('a second supervisor on the same lock is refused', async () => {
    const { configs } = fakeBots();
    const lockPath = join(work, `lock-${Math.random()}`);
    // The test runner's parent is a live process that is not this one.
    writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, ticks: null, children: {} }));
    const sup = supervise(configs, { out: () => {}, lockPath, timing: FAST, spawnArgs: fakeArgs });
    await assert.rejects(sup.result, /another supervisor is already running/);
    assert.ok(existsSync(lockPath), 'the live supervisor lock is untouched');
  });

  test('a stale lock from a dead supervisor is replaced', async () => {
    const lockPath = join(work, `lock-${Math.random()}`);
    writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 22 - 1, ticks: null, children: {} }));
    const lock = new SupervisorLock(lockPath, () => {});
    await lock.acquire();
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, process.pid);
    lock.release();
  });
});

describe('process lifetime', () => {
  const harness = (dir, lockPath) => {
    const path = join(dir, 'harness.mjs');
    writeFileSync(
      path,
      `
import { supervise, loadBotConfig, BOTS } from ${JSON.stringify(SCRIPT_URL)};
const configs = JSON.parse(process.env.HARNESS_CONFIGS);
const sup = supervise(configs, { lockPath: ${JSON.stringify(lockPath)}, timing: { grace: 2000 }, spawnArgs: (bot) => ['--import', ${JSON.stringify(
        'data:text/javascript,' +
          encodeURIComponent(
            "process.on('disconnect',()=>process.kill(process.pid,'SIGTERM'));process.channel?.unref();",
          ),
      )}, bot.entry] });
sup.result.then((code) => { process.exitCode = code; });
`,
    );
    return path;
  };

  test('children stop themselves when the supervisor is hard-killed (no orphans)', async () => {
    const { dir, configs } = fakeBots();
    const lockPath = join(work, `lock-${Math.random()}`);
    const sup = spawn(process.execPath, [harness(dir, lockPath)], {
      env: { ...process.env, HARNESS_CONFIGS: JSON.stringify(configs) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const seen = [];
    sup.stdout.on('data', (chunk) => seen.push(String(chunk)));
    await until(
      () =>
        existsSync(lockPath) &&
        Object.keys(JSON.parse(readFileSync(lockPath, 'utf8')).children).length === 2,
    );
    const { children } = JSON.parse(readFileSync(lockPath, 'utf8'));
    const pids = Object.values(children).map((child) => child.pid);
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    assert.ok(pids.every(alive));
    sup.kill('SIGKILL');
    await until(() => pids.every((pid) => !alive(pid)), 10_000);
  });

  test(
    'SIGTERM to the supervisor is forwarded to both children and exits 0',
    { skip: process.platform === 'win32' ? 'POSIX signals are not available on Windows' : false },
    async () => {
      const { dir, configs } = fakeBots();
      const lockPath = join(work, `lock-${Math.random()}`);
      const sup = spawn(process.execPath, [harness(dir, lockPath)], {
        env: { ...process.env, HARNESS_CONFIGS: JSON.stringify(configs) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      sup.stdout.on('data', (chunk) => (output += chunk));
      await until(() => (output.match(/boot keys=/g) ?? []).length === 2);
      sup.kill('SIGTERM');
      const [code] = await new Promise((resolve) => sup.once('exit', (...args) => resolve(args)));
      assert.equal(code, 0);
      assert.match(output, /\[guardian\] got SIGTERM/);
      assert.match(output, /\[integration\] got SIGTERM/);
      assert.ok(!existsSync(lockPath));
    },
  );
});
