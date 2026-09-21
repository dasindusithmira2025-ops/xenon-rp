import { baseConfig } from './eslint/base.mjs';

export default [
  ...baseConfig(import.meta.dirname),
  {
    // This package *is* the boundary that reads and validates raw environment
    // variables, so the ban on process.env cannot apply to its own source.
    files: ['src/**/*.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
];
