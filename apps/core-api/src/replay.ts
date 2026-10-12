import { NonceCache, SERVICE_MAX_SKEW_SECONDS } from '@xenon/contracts';

/**
 * Replay protection for signed service requests.
 *
 * Core may run several replicas behind one URL, so the primary record of used
 * nonces is Redis (`SET NX EX`): a request replayed to a different replica is
 * still refused. When Redis is unreachable the guard falls back to an
 * in-process cache rather than failing closed - the signature and timestamp
 * window still bound a replay to one replica and a few minutes, and refusing
 * every Discord interaction because a cache is down would be worse.
 */

export interface ReplayGuard {
  /** False when the nonce was already used inside the window. */
  claim(nonce: string): Promise<boolean>;
}

/** The subset of ioredis the guard needs. */
export interface NonceStore {
  set(key: string, value: string, expiry: 'EX', seconds: number, mode: 'NX'): Promise<unknown>;
}

/** Long enough to outlive the signature's validity window on both sides of the clock. */
export const NONCE_TTL_SECONDS = 300;

/** A Redis that hangs must not hold a Discord interaction past its deadline. */
const STORE_TIMEOUT_MS = 500;

export interface ReplayGuardOptions {
  readonly onFallback?: (error: unknown) => void;
  readonly timeoutMs?: number;
}

export function createReplayGuard(
  store: NonceStore | null,
  options: ReplayGuardOptions = {},
): ReplayGuard {
  const local = new NonceCache(Math.max(NONCE_TTL_SECONDS, SERVICE_MAX_SKEW_SECONDS * 2) * 1000);
  const timeoutMs = options.timeoutMs ?? STORE_TIMEOUT_MS;

  return {
    async claim(nonce) {
      if (store === null) return local.remember(nonce);

      const timeout = Promise.withResolvers<never>();
      const timer = setTimeout(() => {
        timeout.reject(new Error('Nonce store timed out'));
      }, timeoutMs);
      try {
        const reply = await Promise.race([
          store.set(`svc:nonce:${nonce}`, '1', 'EX', NONCE_TTL_SECONDS, 'NX'),
          timeout.promise,
        ]);
        // Remembered locally too, so a fall back mid-window still knows it.
        local.remember(nonce);
        return reply === 'OK';
      } catch (error) {
        options.onFallback?.(error);
        return local.remember(nonce);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
