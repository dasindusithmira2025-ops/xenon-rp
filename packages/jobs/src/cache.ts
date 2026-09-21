import { redis } from './redis';

/**
 * Small JSON cache over Redis.
 *
 * Used for values that are expensive to compute and cheap to be slightly stale:
 * the server status board, the published ruleset, the public department list.
 * Every read falls back to the loader on any Redis problem, so a cache outage
 * degrades latency rather than availability.
 */

const PREFIX = 'cache:';

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  try {
    const raw = await redis().get(PREFIX + key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  } catch {
    return undefined;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    await redis().set(PREFIX + key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch {
    /* a cache write failure is never worth failing a request over */
  }
}

export async function cacheDelete(...keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await redis().del(...keys.map((key) => PREFIX + key));
  } catch {
    /* see above */
  }
}

/** Read-through cache. `loader` runs only on a miss or on a Redis failure. */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  const hit = await cacheGet<T>(key);
  if (hit !== undefined) return hit;

  const value = await loader();
  await cacheSet(key, value, ttlSeconds);
  return value;
}
