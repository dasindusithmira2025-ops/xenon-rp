import { describe, expect, it, vi } from 'vitest';

import { silentLogger } from '@xenon/logger';

import { CORE_READY_BACKOFF, waitForCore } from './core-readiness';

import type { CoreCall, CoreResult } from './core-client';

const OK = { ok: true, data: {} } as unknown as CoreResult<never>;
const fail = (code: 'INTEGRATION' | 'INTERNAL' | 'UNAUTHENTICATED') =>
  ({ ok: false, error: { code, message: 'x' } }) as CoreResult<never>;

function scripted(results: CoreResult<never>[]) {
  const calls: unknown[][] = [];
  const core = ((...args: unknown[]) => {
    calls.push(args);
    return Promise.resolve(results[Math.min(calls.length - 1, results.length - 1)]);
  }) as unknown as CoreCall;
  return { core, calls };
}

function logger() {
  const spy = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { spy, logger: { ...silentLogger, ...spy } };
}

describe('waitForCore', () => {
  it('resolves true on the first ok', async () => {
    const { core, calls } = scripted([OK]);
    const log = logger();
    const sleep = vi.fn().mockResolvedValue(undefined);

    const ready = await waitForCore({
      core,
      logger: log.logger,
      signal: new AbortController().signal,
      sleep,
    });

    expect(ready).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('status.board');
    expect(sleep).not.toHaveBeenCalled();
    expect(log.spy.info).toHaveBeenCalledWith('Core API reachable');
  });

  it('retries with growing, capped backoff and logs the failure streak once', async () => {
    const { core, calls } = scripted([
      fail('INTEGRATION'),
      fail('INTERNAL'),
      fail('INTEGRATION'),
      fail('INTEGRATION'),
      fail('INTEGRATION'),
      fail('INTEGRATION'),
      fail('INTEGRATION'),
      fail('INTEGRATION'),
      fail('INTEGRATION'),
      fail('INTEGRATION'),
      fail('INTEGRATION'),
      OK,
    ]);
    const log = logger();
    const delays: number[] = [];

    const ready = await waitForCore({
      core,
      logger: log.logger,
      signal: new AbortController().signal,
      random: () => 0.999999,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });

    expect(ready).toBe(true);
    expect(calls).toHaveLength(12);
    expect(delays[0]).toBeLessThan(CORE_READY_BACKOFF.initialMs);
    expect(delays[1]).toBeGreaterThan(delays[0] ?? 0);
    expect(Math.max(...delays)).toBeLessThan(CORE_READY_BACKOFF.maxMs);
    expect(Math.max(...delays)).toBeGreaterThan(CORE_READY_BACKOFF.maxMs / 2);
    // INTEGRATION, then INTERNAL, then INTEGRATION again: three code changes.
    expect(log.spy.warn).toHaveBeenCalledTimes(3);
  });

  it('logs an error for rejected credentials and keeps retrying', async () => {
    const { core } = scripted([fail('UNAUTHENTICATED'), OK]);
    const log = logger();

    const ready = await waitForCore({
      core,
      logger: log.logger,
      signal: new AbortController().signal,
      sleep: () => Promise.resolve(),
    });

    expect(ready).toBe(true);
    expect(log.spy.error).toHaveBeenCalledTimes(1);
  });

  it('resolves false when aborted while waiting', async () => {
    const controller = new AbortController();
    const { core } = scripted([fail('INTEGRATION')]);

    const ready = await waitForCore({
      core,
      logger: silentLogger,
      signal: controller.signal,
      sleep: () => {
        controller.abort();
        return Promise.resolve();
      },
    });

    expect(ready).toBe(false);
  });

  it('resolves false at once when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { core, calls } = scripted([OK]);

    expect(await waitForCore({ core, logger: silentLogger, signal: controller.signal })).toBe(
      false,
    );
    expect(calls).toHaveLength(0);
  });
});
