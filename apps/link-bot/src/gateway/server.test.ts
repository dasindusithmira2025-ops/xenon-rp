import { once } from 'node:events';

import { DiscordAPIError } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GATEWAY_BODY_LIMIT_BYTES, signServiceRequest, type ServiceName } from '@xenon/contracts';
import { silentLogger } from '@xenon/logger';

import { GatewayFailure, type GatewayHandlers } from './operations';
import { createGatewayServer } from './server';

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const SECRET = 's'.repeat(40);
const GUILD = '100000000000000001';
const MEMBER = '300000000000000003';

let server: Server;
let base: string;
let ready: boolean;
let handlers: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(async () => {
  ready = true;
  handlers = {
    'member.roles': vi.fn().mockResolvedValue({ roleIds: [GUILD] }),
    'member.role': vi
      .fn()
      .mockRejectedValue(
        new GatewayFailure('FORBIDDEN_TARGET', 'Link never manages @everyone.', false),
      ),
    'guild.info': vi
      .fn()
      .mockRejectedValue(
        new DiscordAPIError({ code: 50013, message: 'x' }, 50013, 403, 'GET', '/x', {}),
      ),
  };
  server = createGatewayServer({
    secret: SECRET,
    guildId: GUILD,
    handlers: handlers as unknown as GatewayHandlers,
    isDiscordReady: () => ready,
    logger: silentLogger,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterEach(async () => {
  server.close();
  server.closeAllConnections();
  await once(server, 'close');
});

interface CallOptions {
  readonly secret?: string;
  readonly service?: ServiceName;
  readonly signedPath?: string;
  readonly headers?: Record<string, string>;
}

function signed(op: string, body: unknown, options: CallOptions = {}) {
  const path = `/gateway/v1/${op}`;
  const raw = JSON.stringify(body);
  const headers = {
    ...signServiceRequest(options.secret ?? SECRET, {
      service: options.service ?? 'worker',
      method: 'POST',
      path: options.signedPath ?? path,
      body: raw,
    }),
    ...options.headers,
  };
  return { path, raw, headers };
}

async function post(path: string, raw: string, headers: Record<string, string>) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: raw,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function call(op: string, body: unknown, options: CallOptions = {}) {
  const request = signed(op, body, options);
  return post(request.path, request.raw, request.headers);
}

describe('gateway authentication', () => {
  it('serves a signed request from the worker', async () => {
    const result = await call('member.roles', { discordUserId: MEMBER });
    expect(result).toEqual({ status: 200, body: { ok: true, data: { roleIds: [GUILD] } } });
    expect(handlers['member.roles']).toHaveBeenCalledWith({ discordUserId: MEMBER });
  });

  it('rejects unsigned requests', async () => {
    const result = await post(
      '/gateway/v1/member.roles',
      JSON.stringify({ discordUserId: MEMBER }),
      {},
    );
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
    expect(handlers['member.roles']).not.toHaveBeenCalled();
  });

  it('rejects a request signed as another service or with another secret', async () => {
    expect(
      (await call('member.roles', { discordUserId: MEMBER }, { service: 'link' })).status,
    ).toBe(401);
    expect(
      (await call('member.roles', { discordUserId: MEMBER }, { secret: 'x'.repeat(40) })).status,
    ).toBe(401);
    expect(handlers['member.roles']).not.toHaveBeenCalled();
  });

  it('rejects a signature minted for a different operation', async () => {
    const result = await call(
      'member.roles',
      { discordUserId: MEMBER },
      { signedPath: '/gateway/v1/guild.info' },
    );
    expect(result.status).toBe(401);
    expect(handlers['member.roles']).not.toHaveBeenCalled();
  });

  it('rejects a tampered body', async () => {
    const request = signed('member.roles', { discordUserId: MEMBER });
    const tampered = JSON.stringify({ discordUserId: '300000000000000004' });
    expect((await post(request.path, tampered, request.headers)).status).toBe(401);
  });

  it('rejects a replayed nonce', async () => {
    const request = signed('member.roles', { discordUserId: MEMBER });
    expect((await post(request.path, request.raw, request.headers)).status).toBe(200);
    const replay = await post(request.path, request.raw, request.headers);
    expect(replay.status).toBe(409);
    expect(replay.body).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
    expect(handlers['member.roles']).toHaveBeenCalledTimes(1);
  });

  it('does not burn a nonce on a failed signature', async () => {
    const request = signed('member.roles', { discordUserId: MEMBER });
    const forged = { ...request.headers, 'x-xenon-service-signature': 'f'.repeat(64) };
    expect((await post(request.path, request.raw, forged)).status).toBe(401);
    expect((await post(request.path, request.raw, request.headers)).status).toBe(200);
  });

  it('rejects bodies over the size limit', async () => {
    const result = await call('member.roles', {
      discordUserId: MEMBER,
      padding: 'x'.repeat(GATEWAY_BODY_LIMIT_BYTES),
    });
    expect(result.status).toBe(413);
  });
});

describe('gateway dispatch', () => {
  it('validates input against the operation schema', async () => {
    const result = await call('member.roles', { discordUserId: 'not-a-snowflake' });
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  });

  it('answers unknown operations only after authentication', async () => {
    expect((await call('admin.nuke', {})).status).toBe(404);
    expect((await post('/gateway/v1/admin.nuke', '{}', {})).status).toBe(401);
  });

  it('maps policy refusals and Discord errors', async () => {
    const refused = await call('member.role', {
      discordUserId: MEMBER,
      roleId: GUILD,
      action: 'add',
      reason: 'sync',
    });
    expect(refused).toMatchObject({
      status: 403,
      body: { ok: false, error: { code: 'FORBIDDEN_TARGET', retryable: false } },
    });

    const discord = await call('guild.info', {});
    expect(discord).toMatchObject({
      status: 422,
      body: { ok: false, error: { code: 'DISCORD_ERROR', discordCode: 50013, retryable: false } },
    });
  });
});

describe('gateway health', () => {
  it('reports readiness without authentication or secrets', async () => {
    const ok = await fetch(`${base}/healthz`);
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body).toEqual({ service: 'link', status: 'ok', gateway: 'READY', guildId: GUILD });
    expect(JSON.stringify(body)).not.toContain(SECRET);

    ready = false;
    const connecting = await fetch(`${base}/healthz`);
    expect(connecting.status).toBe(503);
    expect(await connecting.json()).toMatchObject({ status: 'degraded', gateway: 'CONNECTING' });
  });
});
