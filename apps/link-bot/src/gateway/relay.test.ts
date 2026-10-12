import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LINK_RELAY_HEARTBEAT_MS,
  LINK_RELAY_MAX_WAIT_MS,
  SERVICE_NONCE_HEADER,
  SERVICE_SIGNATURE_HEADER,
  type RelayRequest,
} from '@xenon/contracts';
import { silentLogger } from '@xenon/logger';

import { RELAY_BACKOFF, RELAY_DRAIN_TIMEOUT_MS, startGatewayRelay } from './relay';

import type { CoreCall, CoreResult } from '../core-client';
import type { GatewayExecution, GatewayExecutionRequest, GatewayExecutor } from './execute';

const LEASE = 'a'.repeat(32);

function request(n: number, overrides: Partial<RelayRequest> = {}): RelayRequest {
  return {
    id: n.toString(16).padStart(32, '0'),
    lease: LEASE,
    operation: 'guild.info',
    body: '{}',
    timestamp: '1700000000',
    signature: 'b'.repeat(64),
    budgetMs: 15_000,
    ...overrides,
  };
}

const pullOk = (requests: RelayRequest[] = [], claimElapsedMs = 0) =>
  ({ ok: true, data: { requests, claimElapsedMs } }) as unknown as CoreResult<never>;
const failure = (code: string, retryAfterSeconds?: number) =>
  ({
    ok: false,
    error: { code, message: 'x', ...(retryAfterSeconds ? { retryAfterSeconds } : {}) },
  }) as CoreResult<never>;
const accepted = (value: boolean) =>
  ({ ok: true, data: { accepted: value } }) as unknown as CoreResult<never>;

interface Call {
  readonly operation: string;
  readonly input: Record<string, unknown>;
  readonly options: { timeoutMs?: number; signal?: AbortSignal } | undefined;
}
type Step = (call: Call) => CoreResult<never> | Promise<CoreResult<never>>;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** One macrotask: lets every pending microtask chain run to completion. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Pulls follow `pulls`; once exhausted a pull hangs until its signal aborts, like a long-poll. */
function scriptedCore(script: { pulls: Step[]; complete?: Step }) {
  const pulls: Call[] = [];
  const completes: Call[] = [];

  const core = ((operation: string, input: Record<string, unknown>, options: Call['options']) => {
    const call = { operation, input, options };
    if (operation === 'relay.complete') {
      completes.push(call);
      return Promise.resolve((script.complete ?? (() => accepted(true)))(call));
    }
    const step = script.pulls[pulls.length];
    pulls.push(call);
    if (step) return Promise.resolve(step(call));
    return new Promise<CoreResult<never>>((resolve) => {
      const hangUp = () => {
        resolve(failure('INTEGRATION'));
      };
      if (options?.signal?.aborted) hangUp();
      else options?.signal?.addEventListener('abort', hangUp, { once: true });
    });
  }) as unknown as CoreCall;

  const until = async (predicate: () => boolean): Promise<void> => {
    while (!predicate()) await settle();
  };

  return { core, pulls, completes, until };
}

function spyLogger() {
  const spy = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { spy, logger: { ...silentLogger, ...spy } };
}

interface HarnessOptions {
  readonly isDiscordReady?: () => boolean;
  readonly execute?: GatewayExecutor;
  readonly concurrency?: number;
  /** Let the drain sleep finish immediately (a stuck in-flight request). */
  readonly drainImmediately?: boolean;
}

const OK_EXECUTION: GatewayExecution = { status: 200, response: { ok: true, data: { done: 1 } } };

function harness(script: Parameters<typeof scriptedCore>[0], options: HarnessOptions = {}) {
  const scripted = scriptedCore(script);
  const log = spyLogger();
  const sleeps: number[] = [];
  const clock = { t: 0 };
  const execute = options.execute ?? vi.fn<GatewayExecutor>().mockResolvedValue(OK_EXECUTION);

  const relay = startGatewayRelay({
    core: scripted.core,
    execute,
    isDiscordReady: options.isDiscordReady ?? (() => true),
    logger: log.logger,
    concurrency: options.concurrency,
    random: () => 0.999999,
    now: () => clock.t,
    sleep: (ms, signal) => {
      sleeps.push(ms);
      clock.t += ms;
      if (ms === RELAY_DRAIN_TIMEOUT_MS && options.drainImmediately !== true) {
        return new Promise<void>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              resolve();
            },
            { once: true },
          );
        });
      }
      return Promise.resolve();
    },
  });
  return { ...scripted, ...log, relay, sleeps, execute, clock };
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
process.on('unhandledRejection', onUnhandled);

afterEach(() => {
  expect(unhandled).toEqual([]);
});

describe('gateway relay', () => {
  it('sends only zero-capacity heartbeats while Discord is not ready', async () => {
    const h = harness(
      { pulls: [() => pullOk(), () => pullOk(), () => pullOk()] },
      { isDiscordReady: () => false },
    );
    await h.until(() => h.pulls.length >= 4);
    await h.relay.stop();

    for (const call of h.pulls.slice(0, 3)) {
      expect(call.operation).toBe('relay.pull');
      expect(call.input).toEqual({ maxRequests: 0, waitMs: 0, discordReady: false });
    }
    expect(h.sleeps.filter((ms) => ms === LINK_RELAY_HEARTBEAT_MS)).toHaveLength(3);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('long-polls for the free slots only and heartbeats while all slots are busy', async () => {
    const release = deferred();
    const execute = vi.fn<GatewayExecutor>(async () => {
      await release.promise;
      return OK_EXECUTION;
    });
    const h = harness(
      {
        pulls: [
          () => pullOk([request(1), request(2)]),
          async () => {
            await release.promise;
            await settle(); // let both finished requests leave the in-flight set
            return pullOk();
          },
        ],
      },
      { concurrency: 2, execute },
    );

    await h.until(() => h.pulls.length >= 2);
    // First pull asked for both slots with a full long-poll.
    expect(h.pulls[0]?.input).toEqual({
      maxRequests: 2,
      waitMs: LINK_RELAY_MAX_WAIT_MS,
      discordReady: true,
    });
    // Both slots are busy: the next pull is a heartbeat, not a request for more work.
    expect(h.pulls[1]?.input).toEqual({ maxRequests: 0, waitMs: 0, discordReady: true });

    release.resolve();
    await h.until(() => h.pulls.length >= 3);
    expect(h.pulls[2]?.input.maxRequests).toBe(2);
    await h.relay.stop();
  });

  it('completes with the same id, lease and operation and the executor response', async () => {
    const seen: GatewayExecutionRequest[] = [];
    const execute = vi.fn<GatewayExecutor>((r) => {
      seen.push(r);
      return Promise.resolve(OK_EXECUTION);
    });
    const req = request(7, { operation: 'member.roles', body: '{"discordUserId":"1"}' });
    const h = harness({ pulls: [() => pullOk([req])] }, { execute });

    await h.until(() => h.completes.length >= 1);
    await h.relay.stop();

    expect(h.completes[0]?.operation).toBe('relay.complete');
    expect(h.completes[0]?.input).toEqual({
      id: req.id,
      lease: LEASE,
      operation: 'member.roles',
      response: OK_EXECUTION.response,
    });
    expect(seen[0]?.operation).toBe('member.roles');
    expect(seen[0]?.body).toBe(req.body);
    expect(seen[0]?.header('x-xenon-service')).toBe('worker');
    expect(seen[0]?.header(SERVICE_NONCE_HEADER)).toBe(req.id);
    expect(seen[0]?.header(SERVICE_SIGNATURE_HEADER)).toBe(req.signature);
  });
  it('preserves fresh work claimed late in a normal long-poll', async () => {
    const req = request(9, { budgetMs: 15_000 });
    const { promise, resolve } = deferred<CoreResult<never>>();
    const h = harness({ pulls: [() => promise] });
    await h.until(() => h.pulls.length === 1);
    // Core spent 16 s waiting for work; the request is new at claim time.
    h.clock.t = 16_000;
    resolve(pullOk([req], 16_000));
    await h.until(() => h.completes.length >= 1);
    await h.relay.stop();

    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.completes).toHaveLength(1);
  });

  it('drops a response delayed after claim when its remaining budget is exhausted', async () => {
    const req = request(8, { budgetMs: 1_500 });
    const { promise, resolve } = deferred<CoreResult<never>>();
    const h = harness({ pulls: [() => promise] });
    await h.until(() => h.pulls.length === 1);
    // Core claims at request arrival (claimElapsedMs=0), then the response is
    // held in transit for longer than the worker's remaining budget.
    h.clock.t = 1_000;
    resolve(pullOk([req], 0));
    await h.until(() => h.pulls.length >= 2);
    await h.relay.stop();

    expect(h.execute).not.toHaveBeenCalled();
    expect(h.completes).toHaveLength(0);
    expect(h.spy.debug).toHaveBeenCalledWith(
      { operation: req.operation },
      'Dropped stale relay request',
    );
  });

  it('neither executes nor completes a request that arrives with too little budget', async () => {
    const h = harness({
      pulls: [() => pullOk([request(1, { budgetMs: 999 })]), () => pullOk()],
    });

    await h.until(() => h.pulls.length >= 3);
    await h.relay.stop();

    expect(h.execute).not.toHaveBeenCalled();
    expect(h.completes).toHaveLength(0);
  });

  it('retries a failed complete up to three times, then warns', async () => {
    const h = harness({
      pulls: [() => pullOk([request(1)])],
      complete: () => failure('INTEGRATION'),
    });

    await h.until(() => h.spy.warn.mock.calls.length >= 1);
    await h.relay.stop();

    expect(h.completes).toHaveLength(3);
    expect(h.sleeps.slice(0, 2)).toEqual([250, 1_000]);
    expect(h.spy.warn).toHaveBeenCalledWith(
      { operation: 'guild.info' },
      'Relay result could not be delivered',
    );
  });

  it('stops retrying a complete once the request budget is long gone', async () => {
    const h = harness({
      pulls: [() => pullOk([request(1, { budgetMs: 1_000 })])],
      complete: () => failure('INTEGRATION'),
    });
    // 1 000 ms budget + 5 000 ms slack: the 250 ms and 1 000 ms waits still fit.
    await h.until(() => h.spy.warn.mock.calls.length >= 1);
    await h.relay.stop();
    expect(h.completes.length).toBeLessThanOrEqual(3);
  });

  it('logs a discarded result at debug only', async () => {
    const h = harness({ pulls: [() => pullOk([request(1)])], complete: () => accepted(false) });
    await h.until(() => h.completes.length >= 1);
    await h.relay.stop();
    expect(h.spy.debug).toHaveBeenCalledWith(
      { operation: 'guild.info' },
      'Relay result discarded by Core',
    );
    expect(h.spy.warn).not.toHaveBeenCalled();
  });

  it('backs off with growing jittered delays and resets after a success', async () => {
    const h = harness({
      pulls: [
        () => failure('INTEGRATION'),
        () => failure('INTEGRATION'),
        () => failure('INTEGRATION'),
        () => pullOk(),
        () => failure('INTEGRATION'),
      ],
    });

    await h.until(() => h.pulls.length >= 6);
    await h.relay.stop();

    expect(h.sleeps.slice(0, 4)).toEqual([999, 1_999, 3_999, 999]);
    expect(Math.max(...h.sleeps)).toBeLessThan(RELAY_BACKOFF.maxMs);
    // One warning per failure streak, one info on (re)connect.
    expect(h.spy.warn).toHaveBeenCalledTimes(2);
    expect(h.spy.info).toHaveBeenCalledWith('Relay connected');
  });

  it('reports rejected credentials as an error and keeps retrying', async () => {
    const h = harness({ pulls: [() => failure('UNAUTHENTICATED'), () => pullOk()] });
    await h.until(() => h.pulls.length >= 3);
    await h.relay.stop();
    expect(h.spy.error).toHaveBeenCalledTimes(1);
  });

  it('honours retryAfterSeconds on RATE_LIMITED', async () => {
    const h = harness({ pulls: [() => failure('RATE_LIMITED', 7), () => pullOk()] });
    await h.until(() => h.pulls.length >= 3);
    await h.relay.stop();
    expect(h.sleeps[0]).toBe(7_000);
  });

  it('never lets a throwing core or executor escape', async () => {
    const execute = vi.fn<GatewayExecutor>(() => Promise.reject(new Error('boom')));
    const h = harness(
      {
        pulls: [
          () => {
            throw new Error('core exploded');
          },
          () => pullOk([request(1)]),
          () => pullOk(),
        ],
      },
      { execute },
    );

    await h.until(() => h.pulls.length >= 4);
    await h.relay.stop();

    expect(h.spy.error).toHaveBeenCalled();
    expect(h.completes).toHaveLength(0);
    expect(unhandled).toEqual([]);
  });

  it('stop() aborts the pending pull and waits for in-flight work', async () => {
    const release = deferred();
    const execute = vi.fn<GatewayExecutor>(async () => {
      await release.promise;
      return OK_EXECUTION;
    });
    const h = harness({ pulls: [() => pullOk([request(1)])] }, { execute });
    await h.until(() => h.pulls.length >= 2 && execute.mock.calls.length >= 1);

    const pending = h.pulls[1];
    expect(pending?.options?.signal?.aborted).toBe(false);
    let stopped = false;
    const stopping = h.relay.stop().then(() => {
      stopped = true;
    });
    expect(pending?.options?.signal?.aborted).toBe(true);

    await Promise.resolve();
    await Promise.resolve();
    expect(stopped).toBe(false);

    release.resolve();
    await stopping;
    expect(h.completes).toHaveLength(1);
  });

  it('stop() gives up on stuck work after the drain timeout', async () => {
    const execute = vi.fn<GatewayExecutor>(() => new Promise<GatewayExecution>(() => undefined));
    const h = harness({ pulls: [() => pullOk([request(1)])] }, { execute, drainImmediately: true });
    await h.until(() => execute.mock.calls.length >= 1);

    await h.relay.stop();

    expect(h.sleeps).toContain(RELAY_DRAIN_TIMEOUT_MS);
    expect(h.completes).toHaveLength(0);
  });
});
