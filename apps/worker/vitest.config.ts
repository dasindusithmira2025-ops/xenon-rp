import { defineConfig } from 'vitest/config';

// No `load-env` setup file: the transport tests inject every dependency, and
// the database-backed behaviour is covered by @xenon/integration-tests.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
