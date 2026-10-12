import { beforeEach, describe, expect, it } from 'vitest';

import { LINK_RELAY_PRESENCE_TTL_SECONDS } from '@xenon/contracts';

import {
  LINK_RELAY_GRACE_MS,
  LINK_RELAY_MAX_PENDING,
  type LinkRelayEnvelope,
  type LinkRelayStore,
} from './link-relay';

/**
 * Behavioural contract every {@link LinkRelayStore} must satisfy. Run against
 * the in-memory twin with a fake clock, and (when XENON_TEST_REDIS_URL is set)
 * against real Redis, where time cannot be controlled (`clock` is undefined).
 */

export interface FakeClock {
  now(): number;
  advance(ms: number): void;
}

export interface LinkRelayContractTarget {
  /** A store over a clean keyspace. */
  create(clock: FakeClock): LinkRelayStore | Promise<LinkRelayStore>;
  /** False when time cannot be controlled (real Redis): TTL tests are skipped. */
  readonly timeControl: boolean;
}

const TTL = 15_000;
const LEASE = 'a'.repeat(32);
const OTHER_LEASE = 'b'.repeat(32);

export function envelopeFor(n: number, operation: LinkRelayEnvelope['operation'] = 'guild.info') {
  return {
    id: n.toString(16).padStart(32, '0'),
    operation,
    body: '{}',
    timestamp: '1700000000',
    signature: 'c'.repeat(64),
  } satisfies LinkRelayEnvelope;
}

export function describeLinkRelayStore(name: string, target: LinkRelayContractTarget): void {
  describe(`link relay store contract: ${name}`, () => {
    let time = 1_000_000;
    const clock: FakeClock = {
      now: () => time,
      advance: (ms) => {
        time += ms;
      },
    };
    let store: LinkRelayStore;

    beforeEach(async () => {
      time = 1_000_000;
      store = await target.create(clock);
    });

    const claim = (max = 4, minBudgetMs = 3_000, lease = LEASE) =>
      store.claim({ max, lease, minBudgetMs });

    describe('enqueue', () => {
      it('reports offline when no presence was ever written', async () => {
        await expect(store.enqueue(envelopeFor(1), TTL)).resolves.toBe('offline');
        await expect(store.read(envelopeFor(1).id)).resolves.toEqual({ state: 'missing' });
      });

      it('reports not_ready while Link says Discord is unready', async () => {
        await store.markPresence(false);
        await expect(store.enqueue(envelopeFor(1), TTL)).resolves.toBe('not_ready');
      });

      it('queues when ready and rejects a duplicate id', async () => {
        await store.markPresence(true);
        await expect(store.enqueue(envelopeFor(1), TTL)).resolves.toBe('queued');
        await expect(store.read(envelopeFor(1).id)).resolves.toEqual({ state: 'pending' });
        await expect(store.enqueue(envelopeFor(1), TTL)).resolves.toBe('duplicate');
      });

      it(`refuses beyond ${LINK_RELAY_MAX_PENDING} pending requests`, async () => {
        await store.markPresence(true);
        for (let n = 1; n <= LINK_RELAY_MAX_PENDING; n += 1) {
          expect(await store.enqueue(envelopeFor(n), TTL)).toBe('queued');
        }
        await expect(store.enqueue(envelopeFor(LINK_RELAY_MAX_PENDING + 1), TTL)).resolves.toBe(
          'full',
        );
        await expect(store.presence()).resolves.toEqual({
          state: 'ready',
          pending: LINK_RELAY_MAX_PENDING,
        });
      });
    });

    describe('claim', () => {
      beforeEach(async () => {
        await store.markPresence(true);
      });

      it('hands out requests oldest first, up to max, with the lease and remaining budget', async () => {
        await store.enqueue(envelopeFor(1, 'guild.info'), TTL);
        await store.enqueue(envelopeFor(2, 'member.roles'), TTL);
        await store.enqueue(envelopeFor(3, 'role.inspect'), TTL);

        const first = await claim(2);
        expect(first.map((request) => request.id)).toEqual([
          envelopeFor(1).id,
          envelopeFor(2).id,
        ]);
        expect(first[0]).toMatchObject({
          lease: LEASE,
          operation: 'guild.info',
          body: '{}',
          timestamp: '1700000000',
          signature: 'c'.repeat(64),
        });
        expect(first[0]?.budgetMs).toBeGreaterThan(TTL - 1_000);
        expect(first[0]?.budgetMs).toBeLessThanOrEqual(TTL);
        await expect(store.read(envelopeFor(1).id)).resolves.toEqual({ state: 'claimed' });

        const second = await claim(4, 3_000, OTHER_LEASE);
        expect(second.map((request) => request.id)).toEqual([envelopeFor(3).id]);
        expect(second[0]?.lease).toBe(OTHER_LEASE);
        await expect(claim()).resolves.toEqual([]);
      });

      it('claims nothing for max 0', async () => {
        await store.enqueue(envelopeFor(1), TTL);
        await expect(claim(0)).resolves.toEqual([]);
        await expect(store.read(envelopeFor(1).id)).resolves.toEqual({ state: 'pending' });
      });

      it('marks a request with too little budget expired and skips it', async () => {
        await store.enqueue(envelopeFor(1), 1_000);
        await store.enqueue(envelopeFor(2), TTL);
        const claimed = await claim(4, 3_000);
        expect(claimed.map((request) => request.id)).toEqual([envelopeFor(2).id]);
        await expect(store.read(envelopeFor(1).id)).resolves.toEqual({ state: 'expired' });
      });

      it('skips abandoned ids and never claims a request twice', async () => {
        await store.enqueue(envelopeFor(1), TTL);
        await store.enqueue(envelopeFor(2), TTL);
        await store.abandon(envelopeFor(1).id);
        const claimed = await claim();
        expect(claimed.map((request) => request.id)).toEqual([envelopeFor(2).id]);
        await expect(claim()).resolves.toEqual([]);
      });
    });

    describe('complete', () => {
      beforeEach(async () => {
        await store.markPresence(true);
        await store.enqueue(envelopeFor(1, 'member.roles'), TTL);
        await claim();
      });

      const RESPONSE = '{"ok":true,"data":{"roleIds":null}}';
      const input = (patch: Partial<Parameters<LinkRelayStore['complete']>[0]> = {}) => ({
        id: envelopeFor(1).id,
        lease: LEASE,
        operation: 'member.roles' as const,
        response: RESPONSE,
        ...patch,
      });

      it('rejects a wrong lease or operation and leaves the request claimed', async () => {
        await expect(store.complete(input({ lease: OTHER_LEASE }))).resolves.toBe(false);
        await expect(store.complete(input({ operation: 'guild.info' }))).resolves.toBe(false);
        await expect(store.read(envelopeFor(1).id)).resolves.toEqual({ state: 'claimed' });
      });

      it('stores the result, and accepts a retry with the same lease', async () => {
        await expect(store.complete(input())).resolves.toBe(true);
        await expect(store.read(envelopeFor(1).id)).resolves.toEqual({
          state: 'done',
          response: RESPONSE,
        });
        await expect(store.complete(input())).resolves.toBe(true);
      });

      it('does not let a retry overwrite a stored result', async () => {
        await store.complete(input());
        await store.complete(input({ response: '{"ok":true,"data":{"roleIds":[]}}' }));
        await expect(store.read(envelopeFor(1).id)).resolves.toEqual({
          state: 'done',
          response: RESPONSE,
        });
      });

      it('rejects an unknown id and an abandoned request', async () => {
        await expect(store.complete(input({ id: envelopeFor(9).id }))).resolves.toBe(false);
        await store.abandon(envelopeFor(1).id);
        await expect(store.complete(input())).resolves.toBe(false);
      });

      it('rejects a request that was never claimed', async () => {
        await store.enqueue(envelopeFor(2, 'member.roles'), TTL);
        await expect(
          store.complete(input({ id: envelopeFor(2).id })),
        ).resolves.toBe(false);
      });
    });

    describe('abandon', () => {
      beforeEach(async () => {
        await store.markPresence(true);
      });

      it('reports missing for an unknown id', async () => {
        await expect(store.abandon(envelopeFor(1).id)).resolves.toEqual({ state: 'missing' });
      });

      it('returns the prior state and removes the request from the queue', async () => {
        await store.enqueue(envelopeFor(1), TTL);
        await expect(store.abandon(envelopeFor(1).id)).resolves.toEqual({ state: 'pending' });
        await expect(store.read(envelopeFor(1).id)).resolves.toEqual({ state: 'missing' });
        await expect(store.presence()).resolves.toEqual({ state: 'ready', pending: 0 });
      });

      it('returns the response of a finished request', async () => {
        await store.enqueue(envelopeFor(1), TTL);
        await claim();
        await store.complete({
          id: envelopeFor(1).id,
          lease: LEASE,
          operation: 'guild.info',
          response: '{"ok":true,"data":{}}',
        });
        await expect(store.abandon(envelopeFor(1).id)).resolves.toEqual({
          state: 'done',
          response: '{"ok":true,"data":{}}',
        });
        await expect(store.read(envelopeFor(1).id)).resolves.toEqual({ state: 'missing' });
      });

      it('returns claimed for a request Link already took', async () => {
        await store.enqueue(envelopeFor(1), TTL);
        await claim();
        await expect(store.abandon(envelopeFor(1).id)).resolves.toEqual({ state: 'claimed' });
      });
    });

    describe('presence', () => {
      it('is absent until Link pulls, then follows the latest report', async () => {
        await expect(store.presence()).resolves.toEqual({ state: 'absent', pending: 0 });
        await store.markPresence(true);
        await expect(store.presence()).resolves.toMatchObject({ state: 'ready' });
        await store.markPresence(false);
        await expect(store.presence()).resolves.toMatchObject({ state: 'unready' });
      });
    });

    describe.skipIf(!target.timeControl)('expiry (fake clock)', () => {
      it(`drops presence after ${LINK_RELAY_PRESENCE_TTL_SECONDS} s without a pull`, async () => {
        await store.markPresence(true);
        clock.advance(LINK_RELAY_PRESENCE_TTL_SECONDS * 1000 - 1);
        await expect(store.presence()).resolves.toMatchObject({ state: 'ready' });
        clock.advance(1);
        await expect(store.presence()).resolves.toMatchObject({ state: 'absent' });
      });

      it('deletes a request hash ttl + grace after enqueue', async () => {
        await store.markPresence(true);
        await store.enqueue(envelopeFor(1), TTL);
        clock.advance(TTL + LINK_RELAY_GRACE_MS - 1);
        await store.markPresence(true);
        await expect(store.read(envelopeFor(1).id)).resolves.toEqual({ state: 'pending' });
        clock.advance(1);
        await expect(store.read(envelopeFor(1).id)).resolves.toEqual({ state: 'missing' });
      });

      it('computes the remaining budget from the clock at claim time', async () => {
        await store.markPresence(true);
        await store.enqueue(envelopeFor(1), TTL);
        clock.advance(5_000);
        const [request] = await claim();
        expect(request?.budgetMs).toBe(TTL - 5_000);
      });

      it('expires a request that waited too long in the queue', async () => {
        await store.markPresence(true);
        await store.enqueue(envelopeFor(1), TTL);
        clock.advance(TTL - 2_999);
        await expect(claim()).resolves.toEqual([]);
        await expect(store.read(envelopeFor(1).id)).resolves.toEqual({ state: 'expired' });
      });
    });
  });
}
