#!/usr/bin/env node
/**
 * Hosting compatibility check for the dual-bot supervisor. Run it ON the
 * CyberNex instance (or any Linux host) before cut-over:
 *
 *   node scripts/verify-hosting.mjs
 *
 * It exercises exactly what scripts/start-bots.mjs needs from the host, using
 * throwaway fake bots, a temp-dir lock and loopback ephemeral ports. It never
 * reads .env.* files, never logs in to Discord, and never touches `.data/`
 * (beyond a create/delete probe file). Exit 0 only if every check passes.
 */

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { freemem, platform, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { supervise } from './start-bots.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  process.stdout.write(
    `${ok === 'skip' ? 'SKIP' : ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}\n`,
  );
};
const check = async (name, fn) => {
  try {
    const detail = await fn();
    if (detail && typeof detail === 'object' && detail.skip) record(name, 'skip', detail.skip);
    else record(name, true, detail);
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
  }
};

await check('Node.js >= 24.17', () => {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 17)) throw new Error(`found ${process.version}`);
  return process.version;
});

await check('outbound HTTPS to Discord REST', async () => {
  const response = await fetch('https://discord.com/api/v10/gateway', {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return `HTTP ${response.status}`;
});

await check('outbound WebSocket to Discord gateway (connect only, no login)', async () => {
  if (typeof WebSocket === 'undefined') throw new Error('global WebSocket missing');
  await new Promise((resolveWs, reject) => {
    const socket = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('timed out'));
    }, 10_000);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      socket.close();
      resolveWs();
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('connection refused or blocked'));
    });
  });
});

await check('loopback listeners on two ports (health + gateway)', async () => {
  const servers = [createServer(), createServer()];
  const ports = [];
  try {
    for (const server of servers) {
      await new Promise((ok, fail) => {
        server.once('error', fail);
        server.listen(0, '127.0.0.1', ok);
      });
      ports.push(server.address().port);
    }
  } finally {
    servers.forEach((server) => server.close());
  }
  return `bound ${ports.join(', ')}`;
});

await check('spawn two concurrent child processes with IPC', async () => {
  const run = () =>
    new Promise((ok, fail) => {
      const child = spawn(
        process.execPath,
        ['-e', "process.on('message',()=>{});setTimeout(()=>process.exit(0),300)"],
        {
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        },
      );
      child.once('error', fail);
      child.once('exit', (code) => (code === 0 ? ok() : fail(new Error(`exit ${code}`))));
    });
  await Promise.all([run(), run()]);
});

await check('.data/ is writable', () => {
  const dir = join(ROOT, '.data');
  const created = !existsSync(dir);
  mkdirSync(dir, { recursive: true });
  const probe = join(dir, '.write-probe');
  writeFileSync(probe, 'x');
  unlinkSync(probe);
  if (created) rmSync(dir, { recursive: true, force: true });
  return created ? 'created and removed probe dir' : 'existing directory';
});

await check('memory and process limits (informational)', () => {
  const parts = [
    `host RAM ${Math.round(totalmem() / 2 ** 20)} MiB, free ${Math.round(freemem() / 2 ** 20)} MiB`,
  ];
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = readFileSync(file, 'utf8').trim();
      parts.push(
        `cgroup limit ${raw === 'max' ? 'none' : `${Math.round(Number(raw) / 2 ** 20)} MiB`}`,
      );
      break;
    } catch {
      /* not cgroup-limited or not Linux */
    }
  }
  try {
    const line = readFileSync('/proc/self/limits', 'utf8')
      .split('\n')
      .find((l) => l.startsWith('Max processes'));
    if (line) parts.push(line.replace(/\s+/g, ' '));
  } catch {
    /* not Linux */
  }
  return parts.join('; ');
});

await check(
  'supervisor: SIGTERM is forwarded to both children, lock released, exit 0',
  async () => {
    if (platform() === 'win32') return { skip: 'POSIX signals unavailable on Windows' };
    const dir = mkdtempSync(join(tmpdir(), 'xenon-hosting-'));
    try {
      writeFileSync(
        join(dir, 'fake.mjs'),
        "process.on('SIGTERM',()=>{console.log('SIGTERM received');process.exit(0)});setInterval(()=>{},1000);console.log('up')",
      );
      const mk = (name) => ({
        bot: {
          name,
          pkg: 'fake',
          appDir: dir,
          entry: 'fake.mjs',
          critical: name === 'guardian',
          heapMb: 128,
          secretKeys: [],
        },
        cfg: { env: { PATH: process.env.PATH ?? '' }, values: {} },
      });
      const lines = [];
      const lockPath = join(dir, 'lock');
      const supervisor = supervise([mk('guardian'), mk('integration')], {
        lockPath,
        out: (line) => lines.push(line),
        spawnArgs: (bot) => [bot.entry],
      });
      const deadline = Date.now() + 10_000;
      while (lines.filter((l) => l.includes('] up')).length < 2) {
        if (Date.now() > deadline) throw new Error('children did not start');
        await new Promise((r) => setTimeout(r, 50));
      }
      process.kill(process.pid, 'SIGTERM');
      const code = await supervisor.result;
      const received = lines.filter((l) => l.includes('SIGTERM received')).length;
      if (code !== 0) throw new Error(`exit code ${code}`);
      if (received !== 2) throw new Error(`only ${received}/2 children received SIGTERM`);
      if (existsSync(lockPath)) throw new Error('lock not released');
      return '2/2 children terminated gracefully';
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

const failed = results.filter((r) => r.ok === false);
process.stdout.write(
  `\n${failed.length === 0 ? 'ALL CHECKS PASSED' : `${failed.length} CHECK(S) FAILED`}\n`,
);
process.exit(failed.length === 0 ? 0 : 1);
