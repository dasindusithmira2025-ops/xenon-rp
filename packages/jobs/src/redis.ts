import { Redis, type RedisOptions } from 'ioredis';

import { datastoreEnv } from '@xenon/config/datastore';

/**
 * Redis connections.
 *
 * Two pools rather than one. BullMQ's blocking commands occupy a connection for
 * the duration of a `BRPOPLPUSH`, so sharing that connection with ordinary
 * commands (rate limits, caches) would make every cache read wait behind a
 * queue poll. Both are lazily created so importing this module never opens a
 * socket - which matters during a Next.js build, where Redis is not running.
 */

let sharedClient: Redis | undefined;
let queueConnection: Redis | undefined;

function connectionUrl(): string {
  return datastoreEnv.REDIS_URL;
}

const baseOptions: RedisOptions = {
  // Fail fast rather than queueing commands forever when Redis is down: a job
  // enqueue that hangs would hold a request open past its timeout.
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
  retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
};

/** General-purpose client: caches, rate limits, locks. */
export function redis(): Redis {
  sharedClient ??= new Redis(connectionUrl(), baseOptions);
  return sharedClient;
}

/** Dedicated connection handed to BullMQ queues and workers. */
export function queueRedis(): Redis {
  queueConnection ??= new Redis(connectionUrl(), baseOptions);
  return queueConnection;
}

/** Close both pools. Used by tests and by graceful shutdown. */
export async function closeRedis(): Promise<void> {
  await Promise.all([sharedClient?.quit(), queueConnection?.quit()]);
  sharedClient = undefined;
  queueConnection = undefined;
}

/** True when Redis answers a PING. Used by the health endpoint. */
export async function pingRedis(): Promise<boolean> {
  try {
    await redis().ping();
    return true;
  } catch {
    return false;
  }
}
