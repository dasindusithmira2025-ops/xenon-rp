import { defineConfig } from 'vitest/config';

// No `load-env` setup file: the root .env holds real Discord credentials, and
// Link's tests inject every dependency instead of reading configuration.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
