import { createServer } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { guardianHealth, startHealthServer, type HealthServer } from './server';

import type { AddressInfo } from 'node:net';

const GUILD = '123456789012345678';
const TOKEN = 'guardian-secret-token-value';

/** A discord.js-shaped client whose readiness the test controls. */
function fakeClient() {
  const state = { ready: false, guilds: new Set<string>(), ping: -1 };
  return {
    state,
    client: {
      isReady: () => state.ready,
      guilds: { cache: { has: (id: string) => state.guilds.has(id) } },
      ws: {
        get ping() {
          return state.ping;
        },
      },
      // Present on the real client; the endpoint must never serialise it.
      token: TOKEN,
    },
  };
}

let server: HealthServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

async function start(fake: { readonly client: unknown }): Promise<string> {
  server = await startHealthServer({
    host: '127.0.0.1',
    port: 0,
    probe: () => guardianHealth(fake.client as never, GUILD),
  });
  return `http://127.0.0.1:${String(server.port)}`;
}

describe('Guardian health endpoint', () => {
  it('is degraded with 503 until the gateway is ready and the guild resolved', async () => {
    const fake = fakeClient();
    const base = await start(fake);

    const connecting = await fetch(`${base}/healthz`);
    expect(connecting.status).toBe(503);
    expect(await connecting.json()).toMatchObject({
      service: 'guardian',
      status: 'degraded',
      gateway: 'CONNECTING',
      latencyMs: null,
    });

    fake.state.ready = true;
    const guildMissing = await fetch(`${base}/healthz`);
    expect(guildMissing.status).toBe(503);
    expect(await guildMissing.json()).toMatchObject({ status: 'degraded', gateway: 'READY' });
  });

  it('is ok with 200 once ready, without exposing secrets', async () => {
    const fake = fakeClient();
    Object.assign(fake.state, { ready: true, ping: 42 });
    fake.state.guilds.add(GUILD);
    const base = await start(fake);

    const response = await fetch(`${base}/healthz?probe=1`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      service: 'guardian',
      status: 'ok',
      gateway: 'READY',
      guildId: GUILD,
      latencyMs: 42,
      uptimeSeconds: expect.any(Number) as number,
    });
    expect(text).not.toContain(TOKEN);
    expect(text.toLowerCase()).not.toContain('token');
  });

  it('answers 404 for every other path or method', async () => {
    const fake = fakeClient();
    Object.assign(fake.state, { ready: true });
    fake.state.guilds.add(GUILD);
    const base = await start(fake);

    for (const path of ['/', '/health', '/healthz/extra', '/metrics'])
      expect((await fetch(`${base}${path}`)).status, path).toBe(404);
    expect((await fetch(`${base}/healthz`, { method: 'POST' })).status).toBe(404);
  });

  it('rejects when the port is already taken so the caller can log and continue', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const { port } = blocker.address() as AddressInfo;
    try {
      await expect(
        startHealthServer({
          host: '127.0.0.1',
          port,
          probe: () => guardianHealth(fakeClient().client as never, GUILD),
        }),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await new Promise<void>((resolve) =>
        blocker.close(() => {
          resolve();
        }),
      );
    }
  });
});
