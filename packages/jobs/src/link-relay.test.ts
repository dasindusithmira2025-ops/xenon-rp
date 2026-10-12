import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { LINK_RELAY_PRESENCE_TTL_SECONDS } from '@xenon/contracts';

import {
  ABANDON_SCRIPT,
  CLAIM_SCRIPT,
  COMPLETE_SCRIPT,
  ENQUEUE_SCRIPT,
  LINK_RELAY_CLAIM_SCAN_LIMIT,
  LINK_RELAY_GRACE_MS,
  LINK_RELAY_MAX_PENDING,
  LinkRelayUnavailableError,
  createRedisLinkRelayStore,
  linkRelayKeys,
  type LinkRelayRedis,
} from './link-relay';
import { describeLinkRelayStore, envelopeFor } from './link-relay.contract';
import { createMemoryLinkRelayStore } from './testing';

describeLinkRelayStore('memory', {
  timeControl: true,
  create: (clock) => createMemoryLinkRelayStore({ now: () => clock.now() }),
});

// Opt-in real-Redis run of the contract suite; a test input, not build configuration.
// eslint-disable-next-line turbo/no-undeclared-env-vars
const REDIS_URL = process.env.XENON_TEST_REDIS_URL;
if (REDIS_URL) {
  const real = new Redis(REDIS_URL);
  describeLinkRelayStore('real redis', {
    timeControl: false,
    create: async () => {
      const keys = await real.keys('relay:link:*');
      if (keys.length > 0) await real.del(...keys);
      return createRedisLinkRelayStore(real);
    },
  });
  afterAll(async () => {
    await real.quit();
  });
}

interface FakeRedis extends LinkRelayRedis {
  eval: Mock;
  hmget: Mock;
  get: Mock;
  set: Mock;
  llen: Mock;
}

function fakeRedis(): FakeRedis {
  return {
    eval: vi.fn(),
    hmget: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
    llen: vi.fn(),
  };
}

const LEASE = 'a'.repeat(32);

describe('redis link relay store (argument mapping)', () => {
  let client: FakeRedis;
  beforeEach(() => {
    client = fakeRedis();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('declares exactly as many keys as each script reads', () => {
    const highest = (script: string) =>
      Math.max(...[...script.matchAll(/KEYS\[(\d+)\]/g)].map((match) => Number(match[1])));
    expect(highest(ENQUEUE_SCRIPT)).toBe(3);
    expect(highest(CLAIM_SCRIPT)).toBe(1);
    expect(highest(COMPLETE_SCRIPT)).toBe(1);
    expect(highest(ABANDON_SCRIPT)).toBe(2);
  });

  it('enqueues with keys pending, request, presence and the documented ARGV order', async () => {
    client.eval.mockResolvedValue('queued');
    const envelope = envelopeFor(7, 'member.roles');
    await expect(createRedisLinkRelayStore(client).enqueue(envelope, 15_000)).resolves.toBe(
      'queued',
    );
    expect(client.eval).toHaveBeenCalledWith(
      ENQUEUE_SCRIPT,
      3,
      linkRelayKeys.pending,
      `relay:link:req:${envelope.id}`,
      linkRelayKeys.presence,
      envelope.id,
      'member.roles',
      envelope.body,
      envelope.timestamp,
      envelope.signature,
      15_000,
      LINK_RELAY_MAX_PENDING,
      LINK_RELAY_GRACE_MS,
    );
  });

  it.each(['offline', 'not_ready', 'full', 'duplicate'] as const)(
    'passes the %s outcome through',
    async (outcome) => {
      client.eval.mockResolvedValue(outcome);
      await expect(createRedisLinkRelayStore(client).enqueue(envelopeFor(1), 1)).resolves.toBe(
        outcome,
      );
    },
  );

  it('treats an unknown enqueue reply as an unavailable store', async () => {
    client.eval.mockResolvedValue('weird');
    await expect(
      createRedisLinkRelayStore(client).enqueue(envelopeFor(1), 1),
    ).rejects.toBeInstanceOf(LinkRelayUnavailableError);
  });

  it('claims with the pending key and parses the flat 6-tuple reply', async () => {
    const one = envelopeFor(1, 'member.roles');
    const two = envelopeFor(2, 'guild.info');
    client.eval.mockResolvedValue([
      one.id,
      one.operation,
      one.body,
      one.timestamp,
      one.signature,
      14_500,
      two.id,
      two.operation,
      two.body,
      two.timestamp,
      two.signature,
      '9000',
    ]);
    const requests = await createRedisLinkRelayStore(client).claim({
      max: 4,
      lease: LEASE,
      minBudgetMs: 3_000,
    });
    expect(client.eval).toHaveBeenCalledWith(
      CLAIM_SCRIPT,
      1,
      linkRelayKeys.pending,
      4,
      LEASE,
      3_000,
      linkRelayKeys.requestPrefix,
      LINK_RELAY_CLAIM_SCAN_LIMIT,
    );
    expect(requests).toEqual([
      { ...one, lease: LEASE, budgetMs: 14_500 },
      { ...two, lease: LEASE, budgetMs: 9_000 },
    ]);
  });

  it('returns an empty claim without a Redis call for max 0', async () => {
    await expect(
      createRedisLinkRelayStore(client).claim({ max: 0, lease: LEASE, minBudgetMs: 3_000 }),
    ).resolves.toEqual([]);
    expect(client.eval).not.toHaveBeenCalled();
  });

  it('drops a malformed claimed record instead of failing the batch', async () => {
    const good = envelopeFor(2);
    client.eval.mockResolvedValue([
      'not-hex',
      'guild.info',
      '{}',
      '1',
      'c'.repeat(64),
      5_000,
      good.id,
      good.operation,
      good.body,
      good.timestamp,
      good.signature,
      5_000,
    ]);
    const requests = await createRedisLinkRelayStore(client).claim({
      max: 4,
      lease: LEASE,
      minBudgetMs: 3_000,
    });
    expect(requests.map((request) => request.id)).toEqual([good.id]);
  });

  it('rejects a claim reply that is not a list of 6-tuples', async () => {
    client.eval.mockResolvedValue(['a', 'b']);
    await expect(
      createRedisLinkRelayStore(client).claim({ max: 1, lease: LEASE, minBudgetMs: 1 }),
    ).rejects.toBeInstanceOf(LinkRelayUnavailableError);
  });

  it('completes with the request key and lease, operation, response', async () => {
    client.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const store = createRedisLinkRelayStore(client);
    const id = envelopeFor(3).id;
    const input = { id, lease: LEASE, operation: 'guild.info' as const, response: '{"ok":true}' };
    await expect(store.complete(input)).resolves.toBe(true);
    await expect(store.complete(input)).resolves.toBe(false);
    expect(client.eval).toHaveBeenNthCalledWith(
      1,
      COMPLETE_SCRIPT,
      1,
      `relay:link:req:${id}`,
      LEASE,
      'guild.info',
      '{"ok":true}',
    );
  });

  it('abandons with pending and request keys and maps every reply shape', async () => {
    const store = createRedisLinkRelayStore(client);
    const id = envelopeFor(4).id;
    client.eval
      .mockResolvedValueOnce(['done', '{"ok":true}'])
      .mockResolvedValueOnce(['pending'])
      .mockResolvedValueOnce(['claimed'])
      .mockResolvedValueOnce(['expired'])
      .mockResolvedValueOnce(['missing']);
    await expect(store.abandon(id)).resolves.toEqual({ state: 'done', response: '{"ok":true}' });
    await expect(store.abandon(id)).resolves.toEqual({ state: 'pending' });
    await expect(store.abandon(id)).resolves.toEqual({ state: 'claimed' });
    await expect(store.abandon(id)).resolves.toEqual({ state: 'expired' });
    await expect(store.abandon(id)).resolves.toEqual({ state: 'missing' });
    expect(client.eval).toHaveBeenNthCalledWith(
      1,
      ABANDON_SCRIPT,
      2,
      linkRelayKeys.pending,
      `relay:link:req:${id}`,
      id,
    );
  });

  it('reads state and result with one HMGET', async () => {
    const store = createRedisLinkRelayStore(client);
    const id = envelopeFor(5).id;
    client.hmget
      .mockResolvedValueOnce(['done', '{"ok":true}'])
      .mockResolvedValueOnce(['claimed', null])
      .mockResolvedValueOnce([null, null]);
    await expect(store.read(id)).resolves.toEqual({ state: 'done', response: '{"ok":true}' });
    await expect(store.read(id)).resolves.toEqual({ state: 'claimed' });
    await expect(store.read(id)).resolves.toEqual({ state: 'missing' });
    expect(client.hmget).toHaveBeenCalledWith(`relay:link:req:${id}`, 'state', 'res');
  });

  it('writes presence with a 30 s expiry', async () => {
    client.set.mockResolvedValue('OK');
    const store = createRedisLinkRelayStore(client);
    await store.markPresence(true);
    await store.markPresence(false);
    expect(client.set).toHaveBeenNthCalledWith(
      1,
      linkRelayKeys.presence,
      'ready',
      'EX',
      LINK_RELAY_PRESENCE_TTL_SECONDS,
    );
    expect(client.set).toHaveBeenNthCalledWith(
      2,
      linkRelayKeys.presence,
      'unready',
      'EX',
      LINK_RELAY_PRESENCE_TTL_SECONDS,
    );
  });

  it('reads presence and queue depth', async () => {
    const store = createRedisLinkRelayStore(client);
    client.llen.mockResolvedValue(3);
    client.get.mockResolvedValueOnce('ready').mockResolvedValueOnce('unready').mockResolvedValueOnce(null);
    await expect(store.presence()).resolves.toEqual({ state: 'ready', pending: 3 });
    await expect(store.presence()).resolves.toEqual({ state: 'unready', pending: 3 });
    await expect(store.presence()).resolves.toEqual({ state: 'absent', pending: 3 });
    expect(client.get).toHaveBeenCalledWith(linkRelayKeys.presence);
    expect(client.llen).toHaveBeenCalledWith(linkRelayKeys.pending);
  });

  it('wraps a Redis failure with its cause', async () => {
    const cause = new Error('ECONNRESET');
    client.eval.mockRejectedValue(cause);
    const error = await createRedisLinkRelayStore(client)
      .enqueue(envelopeFor(1), 1)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(LinkRelayUnavailableError);
    expect((error as LinkRelayUnavailableError).cause).toBe(cause);
    expect((error as LinkRelayUnavailableError).retryable).toBe(true);
  });

  it('turns a hung Redis call into LinkRelayUnavailableError after timeoutMs', async () => {
    vi.useFakeTimers();
    client.hmget.mockReturnValue(new Promise(() => undefined));
    const outcome = createRedisLinkRelayStore(client, { timeoutMs: 250 })
      .read(envelopeFor(1).id)
      .catch((thrown: unknown) => thrown);
    await vi.advanceTimersByTimeAsync(249);
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toBeInstanceOf(LinkRelayUnavailableError);
  });
});
