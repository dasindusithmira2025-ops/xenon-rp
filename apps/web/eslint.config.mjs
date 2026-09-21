import { nextConfig } from '@xenon/config/eslint/next';

export default [
  ...nextConfig(import.meta.dirname),
  { ignores: ['.next/**', 'next-env.d.ts', 'playwright-report/**', 'test-results/**'] },
];
