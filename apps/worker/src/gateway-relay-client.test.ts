import { describe, expect, it, vi } from 'vitest';

import {
  type GatewayOperation,
  LINK_GATEWAY_PREFIX,
  type RelayRequest,
  verifyServiceRequest,
} from '@xenon/contracts';
import type { LinkRelayStore } from '@xenon/jobs';
import { createMemoryLinkRelayStore } from '@xenon/jobs/testing';

import { DiscordRequestError, GatewayError, isPermanentFailure } from './gateway-client';
import { createRelayGatewayClient } from './gateway-relay-client';
import { gatewayRolePort } from './ports';

const SECRET = 'g'.repeat(48);
const LEASE = 'a'.repeat(32);
const TIMEOUT_MS = 15_000;

type Respond = (operation: GatewayOperation) => unknown;

/**
 * One fake clock shared by the store and the client. Every poll sleep advances
 * it and then lets the fake Link act, so the worker's wait loop is exercised
 * without real time.
 */
function harness(options: { respond?: Respond; complete?: boolean; timeoutMs?: number } = {}) {
  const clock = { t: 1_000_000 };
  const store = createMemoryLinkRelayStore({ now: () => clock.t });
  const claimed: RelayRequest[] = [];
  const verified: boolean[] = [];
  const respond = options.respond;
  const complete = options.complete ?? true;

  async function linkTick(): Promise<void> {
    if (respond === undefined) return;
    const requests = await store.claim({ max: 4, lease: LEASE, minBudgetMs: 3_000 });
    for (const request of requests) {
      claimed.push(request);
      verified.push(
        verifyServiceRequest(
          SECRET,
          { service: 'worker', method: 'POST', path: `${LINK_GATEWAY_PREFIX}/${request.operation}` },
          request.body,
          (name) =>
            ({
              'x-xenon-service': 'worker',
              'x-xenon-service-signature': request.signature,
              'x-xenon-service-timestamp': request.timestamp,
              'x-xenon-service-nonce': request.id,
            })[name] ?? null,
        ).ok,
      );
      if (complete) {
        await store.complete({
          id: request.id,
          lease: request.lease,
          operation: request.operation,
          response: JSON.stringify(respond(request.operation)),
        });
      }
    }
  }

  const client = createRelayGatewayClient({
    store,
    secret: SECRET,
    timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
      await linkTick();
    },
  });
  return { clock, store, client, claimed, verified };
}

const ready = (store: LinkRelayStore) => store.markPresence(true);

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (caught: unknown) => caught,
  );
}

const discordError = (code: string, extra: object = {}, retryable = false) => ({
  ok: false,
  error: { code, message: 'nope', retryable, ...extra },
});

describe('relay gateway client', () => {
  it('signs for the exact operation path, with the nonce as request id', async () => {
    const h = harness({ respond: () => ({ ok: true, data: { roleIds: ['123456789012345678'] } }) });
    await ready(h.store);

    const result = await h.client('member.roles', { discordUserId: '223456789012345678' });

    expect(result.roleIds).toEqual(['123456789012345678']);
    expect(h.claimed).toHaveLength(1);
    expect(h.claimed[0]?.operation).toBe('member.roles');
    expect(h.verified).toEqual([true]);
  });

  it.each([
    ['DISCORD_ERROR 50013', discordError('DISCORD_ERROR', { discordCode: 50013 }), 'discord'],
    ['DISCORD_UNAVAILABLE', discordError('DISCORD_UNAVAILABLE', {}, true), 'retry'],
    ['UNAUTHENTICATED', discordError('UNAUTHENTICATED'), 'retry'],
    ['FORBIDDEN_TARGET', discordError('FORBIDDEN_TARGET'), 'permanent'],
    ['VALIDATION', discordError('VALIDATION'), 'permanent'],
  ])('maps %s like HTTP mode', async (_name, response, kind) => {
    const h = harness({ respond: () => response });
    await ready(h.store);

    const error = await failure(h.client('guild.info', {}));

    if (kind === 'discord') {
      expect(error).toBeInstanceOf(DiscordRequestError);
      expect((error as DiscordRequestError).code).toBe(50013);
      expect(isPermanentFailure(error)).toBe(true);
    } else {
      expect(error).toBeInstanceOf(GatewayError);
      expect(isPermanentFailure(error)).toBe(kind === 'permanent');
    }
  });

  it('treats output that does not match the schema as a retryable protocol error', async () => {
    const h = harness({ respond: () => ({ ok: true, data: { unexpected: true } }) });
    await ready(h.store);

    const error = await failure(h.client('member.roles', { discordUserId: '223456789012345678' }));

    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).gatewayCode).toBe('PROTOCOL');
    expect(isPermanentFailure(error)).toBe(false);
  });

  it('reports a refused role target as a permanent missing-permission to role sync', async () => {
    const h = harness({ respond: () => discordError('FORBIDDEN_TARGET') });
    await ready(h.store);

    const error = await failure(
      gatewayRolePort(h.client).addRole('223456789012345678', '323456789012345678'),
    );

    expect(error).toBeInstanceOf(DiscordRequestError);
    expect((error as DiscordRequestError).code).toBe(50013);
    expect(isPermanentFailure(error)).toBe(true);
  });

  it('fails fast and retryably when Link is offline or not ready', async () => {
    const offline = harness();
    const notReady = harness();
    await notReady.store.markPresence(false);

    const errors = await Promise.all([
      failure(offline.client('guild.info', {})),
      failure(notReady.client('guild.info', {})),
    ]);

    expect((errors[0] as GatewayError).gatewayCode).toBe('NETWORK');
    expect((errors[1] as GatewayError).gatewayCode).toBe('DISCORD_UNAVAILABLE');
    for (const error of errors) expect(isPermanentFailure(error)).toBe(false);
    expect(offline.clock.t).toBe(1_000_000);
  });

  it('reports a full queue as a retryable network error', async () => {
    const h = harness();
    await ready(h.store);
    for (let i = 0; i < 256; i += 1) {
      const outcome = await h.store.enqueue(
        {
          id: i.toString(16).padStart(32, '0'),
          operation: 'guild.info',
          body: '{}',
          timestamp: '1',
          signature: 'b'.repeat(64),
        },
        TIMEOUT_MS,
      );
      expect(outcome).toBe('queued');
    }

    const error = await failure(h.client('guild.info', {}));

    expect((error as GatewayError).gatewayCode).toBe('NETWORK');
    expect(isPermanentFailure(error)).toBe(false);
  });

  it('rejects an oversized body as permanent without enqueueing', async () => {
    const enqueue = vi.fn();
    const client = createRelayGatewayClient({
      store: { enqueue } as unknown as LinkRelayStore,
      secret: SECRET,
    });

    const error = await failure(
      client('guild.info', { padding: 'x'.repeat(70_000) } as never),
    );

    expect((error as GatewayError).gatewayCode).toBe('VALIDATION');
    expect(isPermanentFailure(error)).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('turns an enqueue failure into a retryable network error and abandons best-effort', async () => {
    const abandon = vi.fn().mockResolvedValue({ state: 'missing' });
    const client = createRelayGatewayClient({
      store: {
        enqueue: () => Promise.reject(new Error('redis down')),
        abandon,
      } as unknown as LinkRelayStore,
      secret: SECRET,
    });

    const error = await failure(client('guild.info', {}));

    expect((error as GatewayError).gatewayCode).toBe('NETWORK');
    expect(isPermanentFailure(error)).toBe(false);
    expect(abandon).toHaveBeenCalledTimes(1);
  });

  it('cancels a request nobody took: NETWORK, and a later claim finds nothing', async () => {
    const h = harness();
    await ready(h.store);

    const error = await failure(h.client('guild.info', {}));

    expect((error as GatewayError).gatewayCode).toBe('NETWORK');
    expect((error as GatewayError).message).toMatch(/did not take guild\.info in time/);
    expect(isPermanentFailure(error)).toBe(false);
    await h.store.markPresence(true);
    expect(await h.store.claim({ max: 4, lease: LEASE, minBudgetMs: 0 })).toEqual([]);
  });

  it('keeps a claimed-but-unanswered request retryable; its late complete is refused', async () => {
    const h = harness({ respond: () => ({ ok: true, data: {} }), complete: false });
    await ready(h.store);

    const error = await failure(h.client('guild.info', {}));

    expect((error as GatewayError).gatewayCode).toBe('NETWORK');
    expect((error as GatewayError).message).toMatch(/did not answer guild\.info in time/);
    const [request] = h.claimed;
    expect(request).toBeDefined();
    const late = await h.store.complete({
      id: request!.id,
      lease: request!.lease,
      operation: request!.operation,
      response: JSON.stringify({ ok: true, data: {} }),
    });
    expect(late).toBe(false);
  });

  it('uses a result that lands just before the final abandon', async () => {
    const h = harness({ respond: () => ({ ok: true, data: { roleIds: [] } }) });
    await ready(h.store);
    const readFails = vi.spyOn(h.store, 'read').mockRejectedValue(new Error('flaky'));

    const result = await h.client('member.roles', { discordUserId: '223456789012345678' });

    expect(result.roleIds).toEqual([]);
    expect(readFails).toHaveBeenCalled();
  });

  it('reports a request Core refused to hand out (budget too small) as NETWORK', async () => {
    const h = harness({ respond: () => ({ ok: true, data: {} }), timeoutMs: 2_000 });
    await ready(h.store);

    const error = await failure(h.client('guild.info', {}));

    expect((error as GatewayError).gatewayCode).toBe('NETWORK');
    expect((error as GatewayError).message).toMatch(/did not take the request in time/);
    expect(h.claimed).toHaveLength(0);
  });
});
