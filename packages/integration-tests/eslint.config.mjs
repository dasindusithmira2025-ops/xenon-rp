import { baseConfig } from '@xenon/config/eslint/base';

export default [
  ...baseConfig(import.meta.dirname),
  {
    /*
     * This file's job is to point the suite at its own database before
     * anything loads the validated config, so reading process.env here is the
     * mechanism rather than a shortcut around it.
     */
    files: ['global-setup.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
];
