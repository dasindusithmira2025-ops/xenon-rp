import { once } from 'node:events';
import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CORE_OPERATIONS,
  RELAY_OPERATIONS,
  isRelayOperation,
  signServiceRequest,
} from '@xenon/contracts';
import { ForbiddenError, RateLimitError } from '@xenon/core';
import { createLogger } from '@xenon/logger';

import { createReplayGuard } from './replay';
import { createCoreRequestListener, MAX_BODY_BYTES } from './server';

import type { CoreHandlers } from './operations';
import type { RelayHandlers } from './relay';
import type { AddressInfo } from 'node:net';

const SECRET = 's'.repeat(40);
const ACTOR = '123456789012345678';

const handlers = Object.fromEntries(
  CORE_OPERATIONS.filter((op) => !isRelayOperation(op)).map((op) => [op, vi.fn()]),
) as unknown as {
  [K in keyof CoreHandlers]: ReturnType<typeof vi.fn>;
};
const relay = Object.fromEntries(RELAY_OPERATIONS.map((op) => [op, vi.fn()])) as unknown as {
  [K in keyof RelayHandlers]: ReturnType<typeof vi.fn>;
};
const rateLimit = vi.fn<(actorDiscordId: string) => Promise<void>>();
const ready = vi.fn<() => Promise<boolean>>();

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer(
    createCoreRequestListener({
      secret: SECRET,
      handlers: handlers as unknown as CoreHandlers,
      relay: relay as unknown as RelayHandlers,
      replay: createReplayGuard(null),
      logger: createLogger({ service: 'core-api-test', level: 'fatal', pretty: false }),
      ready,
      rateLimit,
    }),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  server.close();
  await once(server, 'close');
});

beforeEach(() => {
  vi.clearAllMocks();
  rateLimit.mockResolvedValue(undefined);
  ready.mockResolvedValue(true);
});

interface CallOptions {
  readonly secret?: string;
  readonly signedPath?: string;
  readonly headers?: Record<string, string>;
  readonly unsigned?: boolean;
  readonly method?: string;
}

async function call(op: string, payload: unknown, options: CallOptions = {}) {
  const path = `/internal/v1/${op}`;
  const body = JSON.stringify(payload);
  const signed = options.unsigned
    ? {}
    : signServiceRequest(options.secret ?? SECRET, {
        service: 'link',
        method: 'POST',
        path: options.signedPath ?? path,
        body,
      });
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'POST',
    headers: { 'content-type': 'application/json', ...signed, ...options.headers },
    ...(options.method === 'GET' ? {} : { body }),
  });
  return {
    status: response.status,
    body: (await response.json()) as {
      ok: boolean;
      data?: unknown;
      error?: Record<string, unknown>;
    },
    headers: signed,
  };
}

describe('Core API authentication', () => {
  it('rejects an unsigned request before any domain code runs', async () => {
    const result = await call(
      'players.lookup',
      { actorDiscordId: ACTOR, reference: 'XN-1' },
      {
        unsigned: true,
      },
    );
    expect(result.status).toBe(401);
    expect(result.body.error).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(handlers['players.lookup']).not.toHaveBeenCalled();
  });

  it('rejects a request signed with another secret', async () => {
    const result = await call('status.board', {}, { secret: 'x'.repeat(40) });
    expect(result.status).toBe(401);
    expect(handlers['status.board']).not.toHaveBeenCalled();
  });

  it('rejects a signature minted for a different operation path', async () => {
    const result = await call(
      'applications.decide',
      { actorDiscordId: ACTOR, reference: 'XN-WL-0001', action: 'approve' },
      { signedPath: '/internal/v1/status.board' },
    );
    expect(result.status).toBe(401);
    expect(handlers['applications.decide']).not.toHaveBeenCalled();
  });

  it('refuses a replayed request with the same nonce', async () => {
    handlers['status.board'].mockResolvedValue({
      aggregate: 'ONLINE',
      checkedAt: null,
      connectUrl: null,
      servers: [],
    });
    const body = JSON.stringify({});
    const path = '/internal/v1/status.board';
    const headers = signServiceRequest(SECRET, { service: 'link', method: 'POST', path, body });
    const send = () =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      });

    expect((await send()).status).toBe(200);
    const replay = await send();
    expect(replay.status).toBe(409);
    expect(handlers['status.board']).toHaveBeenCalledTimes(1);
  });
});

describe('Core API request handling', () => {
  it('returns 422 for input outside the operation schema without calling the service', async () => {
    const result = await call('players.lookup', {
      actorDiscordId: 'not-a-snowflake',
      reference: 'x',
    });
    expect(result.status).toBe(422);
    expect(result.body.error).toMatchObject({ code: 'VALIDATION' });
    expect(handlers['players.lookup']).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown operation and 405 for a non-POST method', async () => {
    expect((await call('players.delete', {})).status).toBe(404);
    expect((await call('status.board', {}, { method: 'GET', unsigned: true })).status).toBe(405);
  });

  it('refuses an oversized body', async () => {
    const result = await call('players.lookup', {
      actorDiscordId: ACTOR,
      reference: 'x'.repeat(MAX_BODY_BYTES),
    });
    expect(result.status).toBe(413);
  });

  it('maps a domain refusal to its code and safe message only', async () => {
    handlers['applications.queue'].mockRejectedValue(
      new ForbiddenError('applications.view', 'internal-user-id'),
    );
    const result = await call('applications.queue', { actorDiscordId: ACTOR });
    expect(result.status).toBe(403);
    expect(result.body).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'You do not have permission to do that.' },
    });
    expect(JSON.stringify(result.body)).not.toContain('internal-user-id');
  });

  it('collapses an unexpected failure to a generic INTERNAL error', async () => {
    handlers['players.lookup'].mockRejectedValue(
      new Error('connect ECONNREFUSED postgres://admin:hunter2@db/xenon'),
    );
    const result = await call('players.lookup', { actorDiscordId: ACTOR, reference: 'XN-1' });
    expect(result.status).toBe(500);
    expect(result.body.error).toMatchObject({ code: 'INTERNAL' });
    expect(JSON.stringify(result.body)).not.toContain('hunter2');
  });

  it('refuses to send output that does not match the contract', async () => {
    handlers['link.status'].mockResolvedValue({ hasAccount: true, linkedAt: 'tomorrow' });
    const result = await call('link.status', { actorDiscordId: ACTOR });
    expect(result.status).toBe(500);
    expect(result.body.error).toMatchObject({ code: 'INTERNAL' });
  });

  it('applies the per-user rate limit before the service and reports the wait', async () => {
    rateLimit.mockRejectedValue(new RateLimitError(42));
    const result = await call('roles.sync', { actorDiscordId: ACTOR });
    expect(rateLimit).toHaveBeenCalledWith(ACTOR);
    expect(result.status).toBe(429);
    expect(result.body.error).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 42 });
    expect(handlers['roles.sync']).not.toHaveBeenCalled();
  });

  it('returns validated data for a successful operation', async () => {
    handlers['roles.sync'].mockResolvedValue({ queued: true, playerPublicId: 'XN-00001' });
    const result = await call('roles.sync', { actorDiscordId: ACTOR });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, data: { queued: true, playerPublicId: 'XN-00001' } });
    expect(handlers['roles.sync']).toHaveBeenCalledWith({ actorDiscordId: ACTOR });
  });
});

describe('Core API health', () => {
  it('reports liveness without authentication and readiness from the database probe', async () => {
    const live = await fetch(`${base}/healthz`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ service: 'core-api', status: 'ok' });

    ready.mockResolvedValue(false);
    const notReady = await fetch(`${base}/readyz`);
    expect(notReady.status).toBe(503);
    expect(await notReady.json()).toMatchObject({ status: 'degraded' });
  });
});

describe('Core API relay routes', () => {
  const pull = { maxRequests: 2, waitMs: 0, discordReady: true };
  const complete = {
    id: 'a'.repeat(32),
    lease: 'b'.repeat(32),
    operation: 'guild.info',
    response: { ok: true, data: {} },
  };

  it('rejects unsigned relay calls before the handler runs', async () => {
    const result = await call('relay.pull', pull, { unsigned: true });
    expect(result.status).toBe(401);
    expect(relay['relay.pull']).not.toHaveBeenCalled();
  });

  it('rejects a relay signature minted for another operation', async () => {
    const result = await call('relay.complete', complete, {
      signedPath: '/internal/v1/relay.pull',
    });
    expect(result.status).toBe(401);
    expect(relay['relay.complete']).not.toHaveBeenCalled();
  });

  it('refuses a replayed relay.complete', async () => {
    relay['relay.complete'].mockResolvedValue({ accepted: true });
    const body = JSON.stringify(complete);
    const path = '/internal/v1/relay.complete';
    const headers = signServiceRequest(SECRET, { service: 'link', method: 'POST', path, body });
    const send = () =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(409);
    expect(relay['relay.complete']).toHaveBeenCalledTimes(1);
  });

  it('validates relay input and never rate-limits by actor', async () => {
    const result = await call('relay.pull', { ...pull, maxRequests: 9 });
    expect(result.status).toBe(422);
    expect(relay['relay.pull']).not.toHaveBeenCalled();

    relay['relay.pull'].mockResolvedValue({ requests: [], claimElapsedMs: 0 });
    const ok = await call('relay.pull', pull);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({
      ok: true,
      data: { requests: [], claimElapsedMs: 0 },
    });
    expect(rateLimit).not.toHaveBeenCalled();
    expect(relay['relay.pull'].mock.calls[0]?.[0]).toEqual(pull);
    expect(relay['relay.pull'].mock.calls[0]?.[1]).toHaveProperty('signal');
    expect(handlers['status.board']).not.toHaveBeenCalled();
  });

  it('answers a pull cap with 429 and retryAfterSeconds', async () => {
    relay['relay.pull'].mockRejectedValue(new RateLimitError(1));
    const result = await call('relay.pull', pull);
    expect(result.status).toBe(429);
    expect(result.body.error).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 1 });
  });

  it('passes a signal that aborts when the client disconnects', async () => {
    relay['relay.pull'].mockReturnValue(new Promise(() => undefined));
    const body = JSON.stringify(pull);
    const path = '/internal/v1/relay.pull';
    const headers = signServiceRequest(SECRET, { service: 'link', method: 'POST', path, body });
    const controller = new AbortController();
    const request = fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
      signal: controller.signal,
    }).catch(() => undefined);

    await vi.waitFor(() => {
      expect(relay['relay.pull']).toHaveBeenCalledOnce();
    });
    const context = relay['relay.pull'].mock.calls[0]?.[1] as { signal: AbortSignal };
    const signal = context.signal;
    expect(signal.aborted).toBe(false);
    const aborted = new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => {
        resolve();
      });
    });
    controller.abort();
    await aborted;
    expect(signal.aborted).toBe(true);
    await request;
  });

  it('refuses relay output outside its contract', async () => {
    relay['relay.pull'].mockResolvedValue({ requests: [{ id: 'nope' }] });
    const result = await call('relay.pull', pull);
    expect(result.status).toBe(500);
  });

  it('leaves domain operations on their own handlers', async () => {
    handlers['status.board'].mockResolvedValue({
      aggregate: 'ONLINE',
      checkedAt: null,
      connectUrl: null,
      servers: [],
    });
    expect((await call('status.board', {})).status).toBe(200);
    expect(relay['relay.pull']).not.toHaveBeenCalled();
    expect(relay['relay.complete']).not.toHaveBeenCalled();
  });
});

describe('replay guard', () => {
  it('uses the shared store and refuses a nonce it has already seen', async () => {
    const set = vi.fn().mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    const guard = createReplayGuard({ set });
    expect(await guard.claim('a'.repeat(32))).toBe(true);
    expect(await guard.claim('a'.repeat(32))).toBe(false);
    expect(set).toHaveBeenCalledWith(`svc:nonce:${'a'.repeat(32)}`, '1', 'EX', 300, 'NX');
  });

  it('falls back to the in-process cache when the store fails or hangs', async () => {
    const onFallback = vi.fn();
    const failing = createReplayGuard(
      { set: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) },
      { onFallback },
    );
    expect(await failing.claim('b'.repeat(32))).toBe(true);
    expect(await failing.claim('b'.repeat(32))).toBe(false);
    expect(onFallback).toHaveBeenCalledTimes(2);

    const hanging = createReplayGuard(
      { set: () => new Promise(() => undefined) },
      { timeoutMs: 10 },
    );
    expect(await hanging.claim('c'.repeat(32))).toBe(true);
    expect(await hanging.claim('c'.repeat(32))).toBe(false);
  });
});
