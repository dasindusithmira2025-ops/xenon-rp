import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/client/client';

/**
 * Transaction-aware client handle.
 *
 * Every service function takes this rather than the concrete `PrismaClient`, so
 * the same code runs inside or outside an interactive transaction. Domain
 * operations that must be atomic therefore compose without duplication.
 */
export type Db = Omit<PrismaClient, '$connect' | '$disconnect' | '$transaction' | '$extends'>;

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
