import { defineConfig } from 'vitest/config';

import { testDatabaseUrl } from './global-setup';

/**
 * These tests talk to a real PostgreSQL database.
 *
 * Not mocks: the things most worth proving here - that an approval and the
 * whitelist it confers commit together, that a revision mismatch is refused,
 * that a unique constraint stops a double link - are exactly the behaviours a
 * mocked Prisma client would happily fake.
 *
 * One fork, one file at a time. The suite truncates between tests, so parallel
 * files would delete each other's fixtures halfway through.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globalSetup: ['./global-setup.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      // Set before anything imports the client, and `process.loadEnvFile`
      // leaves defined variables alone, so this beats the root .env rather
      // than fighting it. The development database is never touched.
      DATABASE_URL: testDatabaseUrl(),
    },
  },
});
