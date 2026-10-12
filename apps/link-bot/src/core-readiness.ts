import type { Logger } from '@xenon/logger';

import { abortableSleep, jitteredBackoff } from './sleep';

import type { CoreCall } from './core-client';

/**
 * Link registers slash commands only once Core answers. Without this gate a
 * restart while Core is down would advertise whitelist and identity commands
 * that cannot work. Commands registered earlier are left in place: clearing
 * them on every restart would make them flicker, and while Core is down they
 * already answer with the "temporarily unavailable" message.
 */

export const CORE_READY_BACKOFF = { initialMs: 2_000, maxMs: 60_000 } as const;

const PROBE_TIMEOUT_MS = 5_000;

export interface CoreReadinessOptions {
  readonly core: CoreCall;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly random?: () => number;
}

/** Resolves true once `status.board` succeeds; false if aborted first. */
export async function waitForCore(options: CoreReadinessOptions): Promise<boolean> {
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;
  let attempt = 0;
  let loggedCode: string | null = null;

  while (!options.signal.aborted) {
    const result = await options
      .core('status.board', {}, { timeoutMs: PROBE_TIMEOUT_MS, signal: options.signal })
      .catch(() => null);

    if (result?.ok === true) {
      options.logger.info('Core API reachable');
      return true;
    }

    const code = result?.error.code ?? 'INTEGRATION';
    if (code !== loggedCode) {
      loggedCode = code;
      if (code === 'UNAUTHENTICATED') {
        options.logger.error(
          { code },
          'Core API rejected Link credentials; check LINK_CORE_SECRET. Commands stay unregistered until it is reachable',
        );
      } else {
        options.logger.warn(
          { code },
          'Core API not reachable; Link commands stay unregistered until it is',
        );
      }
    }

    await sleep(jitteredBackoff(attempt, CORE_READY_BACKOFF, random), options.signal);
    attempt += 1;
  }
  return false;
}
