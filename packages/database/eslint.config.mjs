import { baseConfig } from '@xenon/config/eslint/base';

export default [
  ...baseConfig(import.meta.dirname),
  { ignores: ['generated/**'] },
  {
    // The client reads DATABASE_URL directly: it is the one variable both the
    // web tier and the bot share, and each validates it through @xenon/config
    // at startup before this module is ever reached.
    files: ['src/client.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
];
