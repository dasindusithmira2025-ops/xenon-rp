// Side-effect import, deliberately first.
//
// This module constructs a client the instant it is evaluated, and it cannot do
// that without DATABASE_URL. Loading the root `.env` here rather than trusting
// every entry point to do it first removes an entire class of ordering bug:
// a bundler is free to hoist this module above whatever the entry file imported
// to set the environment up, and then the failure is a confusing "DATABASE_URL
// is not set" from a process whose `.env` is perfectly correct.
import '@xenon/config/load-env';

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/client/client';

/**
 * Transaction-aware client handle.
 *
 * Every service function takes this rather than the concrete `PrismaClient`, so
 * the same code runs inside or outside an interactive transaction. Domain
 * operations that must be atomic therefore compose without duplication.
 */
export type Db = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$transaction' | '$extends' | '$on' | '$use'
>;

declare global {
  var __xenonPrisma__: PrismaClient | undefined;
}

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env at the repo root, or export it in the environment.',
    );
  }

  return new PrismaClient({
    // Prisma 7 talks to Postgres through a driver adapter rather than a bundled
    // native engine, which is what lets the same client run on edge runtimes.
    adapter: new PrismaPg({ connectionString }),
    log:
      process.env.NODE_ENV === 'development'
        ? [
            { level: 'warn', emit: 'stdout' },
            { level: 'error', emit: 'stdout' },
          ]
        : [{ level: 'error', emit: 'stdout' }],
  });
}

/**
 * Process-wide client.
 *
 * Cached on `globalThis` in development because Next.js hot reload re-evaluates
 * modules on every edit, and a fresh pool per edit exhausts Postgres connections
 * within a few minutes.
 */
export const prisma: PrismaClient = globalThis.__xenonPrisma__ ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalThis.__xenonPrisma__ = prisma;
}

/**
 * Run `fn` atomically.
 *
 * `Db` deliberately omits `$transaction` so that a service cannot start a
 * nested transaction by accident. This helper closes the gap: given the root
 * client it opens a transaction, and given a transaction handle it simply runs
 * the callback, because the caller is already inside one. Services therefore
 * compose - `approveApplication` can call `grantWhitelist` and both end up in
 * the same atomic unit without either knowing about the other.
 */
export async function transaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  if ('$transaction' in db && typeof (db as PrismaClient).$transaction === 'function') {
    return (db as PrismaClient).$transaction((tx) => fn(tx));
  }
  return fn(db);
}
