import { isProduction } from '@xenon/config/datastore';

import type { Db } from './client';

/**
 * Empty every table in the public schema.
 *
 * For test databases only, and it refuses outright when NODE_ENV says
 * production - this is the one function in the repository that can destroy
 * everything, so the guard lives here rather than in each caller.
 *
 * Truncate rather than delete-in-order: the schema has enough cycles
 * (submissions reference users, users reference submissions through assignee)
 * that a hand-maintained delete order breaks every time somebody adds a
 * relation. Table names come from the catalogue, so that list cannot go stale
 * either.
 *
 * `_prisma_migrations` is preserved: the schema is already at the right
 * version and re-running migrations to rebuild it would make every test run
 * several seconds slower for nothing.
 */
export async function truncateAll(db: Db): Promise<number> {
  if (isProduction()) {
    throw new Error('truncateAll must never run against production.');
  }

  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (tables.length === 0) return 0;

  const list = tables.map((row) => `"public"."${row.tablename}"`).join(', ');
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);

  return tables.length;
}
