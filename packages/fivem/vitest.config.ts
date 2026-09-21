import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // These modules reach `@xenon/database` through the domain package, and the
    // Prisma client refuses to construct without DATABASE_URL. Loading the root
    // `.env` here keeps the unit tests runnable from a fresh clone without
    // every test file remembering to do it.
    setupFiles: ['@xenon/config/load-env'],
  },
});
