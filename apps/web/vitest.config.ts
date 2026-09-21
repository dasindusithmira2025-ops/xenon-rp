import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['@xenon/config/load-env'],
    // Playwright owns e2e/; vitest must not try to run those specs.
    exclude: ['e2e/**', 'node_modules/**'],
  },
});
