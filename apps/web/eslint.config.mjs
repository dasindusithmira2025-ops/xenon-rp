import { nextConfig } from '@xenon/config/eslint/next';

export default [
  ...nextConfig(import.meta.dirname),
  {
    // `.next*` rather than `.next`: the E2E suite builds into its own
    // directory, and linting a build output produces several hundred errors
    // about generated files.
    ignores: ['.next*/**', 'next-env.d.ts', 'playwright-report/**', 'test-results/**'],
  },
];
