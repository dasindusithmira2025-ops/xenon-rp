import { describe, expect, it, vi } from 'vitest';

import { IntegrationError, RateLimitError, ValidationError } from '@xenon/core';
import { LinkRelayUnavailableError, type LinkRelayStore } from '@xenon/jobs';
import { createMemoryLinkRelayStore } from '@xenon/jobs/testing';
import type { Logger } from '@xenon/logger';

import { createRelayOperations, type RelayOperationsDeps } from './relay';

const LEASE = 'e'.repeat(32);
const SIGNATURE = 'c'.repeat(64);
const GUILD = { guildId: '123456789012345678', name: 'Xenon', iconUrl: null, memberCount: 7 };

function id(n: number): string {
  return n.toString(16).padStart(32, '0');
}

function fakeLogger() {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: logger as unknown as Logger, calls: logger };
}

interface Rig {
  readonly store: LinkRelayStore;
  readonly relay: ReturnType<typeof createRelayOperations>;
  readonly sleeps: number[];
  readonly calls: ReturnType<typeof fakeLogger>['calls'];
  mono(): number;
  advance(ms: number): void;
  enqueue(n: number, operation?: 'guild.info' | 'member.roles'): Promise<void>;
}

/** Memory store + fake monotonic clock; `onSleep` runs instead of waiting. */
function rig(
  options: {
    readonly onSleep?: (ms: number, signal: AbortSignal, count: number) => Promise<void> | void;
  } & Partial<RelayOperationsDeps> = {},
): Rig {
  let mono = 0;
  const sleeps: number[] = [];
  const store = options.store ?? createMemoryLinkRelayStore();
  const { logger, calls } = fakeLogger();
  const relay = createRelayOperations({
    store,
    logger,
    newLease: () => LEASE,
    now: () => mono,
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      mono += ms;
      await options.onSleep?.(ms, signal, sleeps.length);
    },
    ...options,
  });
  return {
    store,
    relay,
    sleeps,
    calls,
    mono: () => mono,
    advance: (ms) => {
      mono += ms;
    },
    enqueue: async (n, operation = 'guild.info') => {
      await store.enqueue(
        { id: id(n), operation, body: '{}', timestamp: '1700000000', signature: SIGNATURE },
        15_000,
      );
    },
  };
}

const context = () => ({ signal: new AbortController().signal });
const pull = (maxRequests: number, waitMs: number, discordReady = true) => ({
  maxRequests,
  waitMs,
  discordReady,
});

describe('relay.pull', () => {
  it('returns at once when work is queued', async () => {
    const r = rig();
    await r.store.markPresence(true);
    await r.enqueue(1);
    const result = await r.relay.handlers['relay.pull'](pull(4, 20_000), context());
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({ id: id(1), lease: LEASE, operation: 'guild.info' });
    expect(result.requests[0]?.budgetMs).toBeGreaterThan(14_000);
    expect(r.sleeps).toEqual([]);
    expect(r.calls.info).toHaveBeenCalledOnce();
  });

  it('records presence on every pull, including the ready flag', async () => {
    const r = rig();
    await r.relay.handlers['relay.pull'](pull(1, 0), context());
    await expect(r.store.presence()).resolves.toMatchObject({ state: 'ready' });
    await r.relay.handlers['relay.pull'](pull(1, 0, false), context());
    await expect(r.store.presence()).resolves.toMatchObject({ state: 'unready' });
  });

  it('returns work enqueued while it waits on the next tick', async () => {
    const r = rig({
      onSleep: async (_ms, _signal, count) => {
        if (count === 2) await r.enqueue(5);
      },
    });
    await r.store.markPresence(true);
    const result = await r.relay.handlers['relay.pull'](pull(4, 20_000), context());
    expect(result.requests.map((request) => request.id)).toEqual([id(5)]);
    expect(r.sleeps).toEqual([200, 200]);
  });

  it('returns how long Core waited before claiming fresh work', async () => {
    const r = rig({
      onSleep: async (_ms, _signal, count) => {
        if (count === 80) await r.enqueue(6);
      },
    });
    await r.store.markPresence(true);
    const result = await r.relay.handlers['relay.pull'](pull(4, 20_000), context());

    expect(result.requests.map((request) => request.id)).toEqual([id(6)]);
    expect(result.claimElapsedMs).toBe(16_000);
  });
  it('measures claim age before awaiting Redis so a slow reply is conservative', async () => {
    const r = rig();
    await r.store.markPresence(true);
    await r.enqueue(7);
    const claim = r.store.claim.bind(r.store);
    vi.spyOn(r.store, 'claim').mockImplementation(async (options) => {
      const requests = await claim(options);
      if (requests.length > 0) r.advance(16_000);
      return requests;
    });

    const result = await r.relay.handlers['relay.pull'](pull(4, 20_000), context());

    expect(result.requests.map((request) => request.id)).toEqual([id(7)]);
    expect(r.mono()).toBe(16_000);
    expect(result.claimElapsedMs).toBe(0);
  });

  it('returns an empty batch once waitMs has passed', async () => {
    const r = rig();
    const result = await r.relay.handlers['relay.pull'](pull(4, 1_000), context());
    expect(result).toMatchObject({ requests: [], claimElapsedMs: 1_000 });
    expect(r.sleeps).toEqual([200, 200, 200, 200, 200]);
    expect(r.mono()).toBe(1_000);
  });

  it('never sleeps past the remaining wait', async () => {
    const r = rig({ pollIntervalMs: 300 });
    await r.relay.handlers['relay.pull'](pull(1, 700), context());
    expect(r.sleeps).toEqual([300, 300, 100]);
  });

  it('claims nothing while Discord is unready', async () => {
    const r = rig();
    await r.store.markPresence(true);
    await r.enqueue(1);
    const result = await r.relay.handlers['relay.pull'](pull(4, 20_000, false), context());
    expect(result).toMatchObject({ requests: [] });
    expect(r.sleeps).toEqual([]);
    await expect(r.store.presence()).resolves.toEqual({ state: 'unready', pending: 1 });
    await expect(r.store.read(id(1))).resolves.toEqual({ state: 'pending' });
  });

  it('treats maxRequests 0 as a heartbeat only', async () => {
    const r = rig();
    await r.store.markPresence(true);
    await r.enqueue(1);
    const result = await r.relay.handlers['relay.pull'](pull(0, 20_000), context());
    expect(result).toMatchObject({ requests: [] });
    expect(r.sleeps).toEqual([]);
    await expect(r.store.read(id(1))).resolves.toEqual({ state: 'pending' });
  });

  it('refuses a third concurrent pull and ends the others on close()', async () => {
    const parked = (_ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          resolve();
        });
      });
    const r = rig({ onSleep: parked });
    const first = r.relay.handlers['relay.pull'](pull(1, 20_000), context());
    const second = r.relay.handlers['relay.pull'](pull(1, 20_000), context());
    await vi.waitFor(() => {
      expect(r.sleeps).toHaveLength(2);
    });
    const third = r.relay.handlers['relay.pull'](pull(1, 20_000), context());
    await expect(third).rejects.toBeInstanceOf(RateLimitError);
    await expect(third).rejects.toMatchObject({ retryAfterSeconds: 1 });

    r.relay.close();
    await expect(first).resolves.toMatchObject({ requests: [] });
    await expect(second).resolves.toMatchObject({ requests: [] });
  });

  it('frees the slot when a pull ends', async () => {
    const r = rig({ maxConcurrentPulls: 1 });
    await r.relay.handlers['relay.pull'](pull(1, 0), context());
    await expect(r.relay.handlers['relay.pull'](pull(1, 0), context())).resolves.toMatchObject({
      requests: [],
    });
  });

  it('frees the slot when the store fails', async () => {
    const store = createMemoryLinkRelayStore();
    const markPresence = vi
      .spyOn(store, 'markPresence')
      .mockRejectedValueOnce(new LinkRelayUnavailableError(new Error('down')));
    const r = rig({ store, maxConcurrentPulls: 1 });
    await expect(r.relay.handlers['relay.pull'](pull(1, 0), context())).rejects.toBeInstanceOf(
      LinkRelayUnavailableError,
    );
    markPresence.mockRestore();
    await expect(r.relay.handlers['relay.pull'](pull(1, 0), context())).resolves.toMatchObject({
      requests: [],
    });
  });

  it('claims nothing once the client has gone', async () => {
    const r = rig();
    await r.store.markPresence(true);
    await r.enqueue(1);
    const controller = new AbortController();
    controller.abort();
    const result = await r.relay.handlers['relay.pull'](pull(4, 20_000), {
      signal: controller.signal,
    });
    expect(result).toMatchObject({ requests: [] });
    await expect(r.store.read(id(1))).resolves.toEqual({ state: 'pending' });
  });

  it('stops waiting, without claiming, when the client disconnects mid-wait', async () => {
    const controller = new AbortController();
    const r = rig({
      onSleep: async (_ms, _signal, count) => {
        if (count === 1) {
          controller.abort();
          await r.enqueue(1);
        }
      },
    });
    await r.store.markPresence(true);
    const result = await r.relay.handlers['relay.pull'](pull(4, 20_000), {
      signal: controller.signal,
    });
    expect(result).toMatchObject({ requests: [] });
    await expect(r.store.read(id(1))).resolves.toEqual({ state: 'pending' });
  });

  it('surfaces a Redis failure as an IntegrationError and warns', async () => {
    const down = new LinkRelayUnavailableError(new Error('ECONNRESET'));
    const store = createMemoryLinkRelayStore();
    vi.spyOn(store, 'markPresence').mockRejectedValue(down);
    const r = rig({ store });
    const error = await r.relay.handlers['relay.pull'](pull(1, 0), context()).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(IntegrationError);
    expect(r.calls.warn).toHaveBeenCalledOnce();
  });
});

describe('relay.complete', () => {
  async function claimed(r: Rig, n = 1, operation: 'guild.info' | 'member.roles' = 'guild.info') {
    await r.store.markPresence(true);
    await r.enqueue(n, operation);
    await r.relay.handlers['relay.pull'](pull(4, 0), context());
  }

  it('stores the validated result and reports acceptance', async () => {
    const r = rig();
    await claimed(r);
    const result = await r.relay.handlers['relay.complete'](
      {
        id: id(1),
        lease: LEASE,
        operation: 'guild.info',
        response: { ok: true, data: { ...GUILD, extra: 'dropped' } },
      },
      context(),
    );
    expect(result).toEqual({ accepted: true });
    const stored = await r.store.read(id(1));
    expect(stored.state).toBe('done');
    if (stored.state === 'done')
      expect(JSON.parse(stored.response)).toEqual({ ok: true, data: GUILD });
  });

  it('stores an error envelope as given', async () => {
    const r = rig();
    await claimed(r, 1, 'member.roles');
    const response = {
      ok: false as const,
      error: {
        code: 'DISCORD_ERROR' as const,
        message: 'Missing Permissions',
        retryable: false,
        discordCode: 50013,
      },
    };
    await expect(
      r.relay.handlers['relay.complete'](
        { id: id(1), lease: LEASE, operation: 'member.roles', response },
        context(),
      ),
    ).resolves.toEqual({ accepted: true });
    await expect(r.store.read(id(1))).resolves.toEqual({
      state: 'done',
      response: JSON.stringify(response),
    });
  });

  it('rejects ok data outside the operation output schema without touching the store', async () => {
    const r = rig();
    await claimed(r);
    const complete = vi.spyOn(r.store, 'complete');
    await expect(
      r.relay.handlers['relay.complete'](
        {
          id: id(1),
          lease: LEASE,
          operation: 'guild.info',
          response: { ok: true, data: { nope: 1 } },
        },
        context(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(complete).not.toHaveBeenCalled();
    await expect(r.store.read(id(1))).resolves.toEqual({ state: 'claimed' });
  });

  it('returns accepted:false for a wrong lease, a wrong operation and an unknown id', async () => {
    const r = rig();
    await claimed(r);
    const base = {
      lease: LEASE,
      operation: 'guild.info' as const,
      response: { ok: true as const, data: GUILD },
    };
    const complete = r.relay.handlers['relay.complete'];
    await expect(
      complete({ ...base, id: id(1), lease: 'f'.repeat(32) }, context()),
    ).resolves.toEqual({ accepted: false });
    await expect(complete({ ...base, id: id(9) }, context())).resolves.toEqual({ accepted: false });
    await expect(
      complete(
        {
          id: id(1),
          lease: LEASE,
          operation: 'member.roles',
          response: { ok: true, data: { roleIds: null } },
        },
        context(),
      ),
    ).resolves.toEqual({ accepted: false });
  });

  it('surfaces a Redis failure as an IntegrationError and warns', async () => {
    const store = createMemoryLinkRelayStore();
    vi.spyOn(store, 'complete').mockRejectedValue(new LinkRelayUnavailableError());
    const r = rig({ store });
    await expect(
      r.relay.handlers['relay.complete'](
        { id: id(1), lease: LEASE, operation: 'guild.info', response: { ok: true, data: GUILD } },
        context(),
      ),
    ).rejects.toBeInstanceOf(IntegrationError);
    expect(r.calls.warn).toHaveBeenCalledOnce();
  });
});
