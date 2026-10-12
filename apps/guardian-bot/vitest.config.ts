import { defineConfig } from 'vitest/config';

// No env setup file: Guardian never loads the root `.env`, and its tests must
// not depend on (or ever see) real credentials.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
