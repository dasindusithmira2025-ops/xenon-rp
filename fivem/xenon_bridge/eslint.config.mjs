import { baseConfig } from '@xenon/config/eslint/base';

export default [
  ...baseConfig(import.meta.dirname),
  {
    ignores: ['dist/**'],
  },
  {
    /*
     * FiveM's server runtime exposes its API as globals rather than as modules,
     * so `no-undef` has nothing to resolve them against. They are declared in
     * src/fivem.d.ts and typechecked; the rule is redundant here.
     */
    files: ['src/**/*.ts'],
    rules: {
      'no-undef': 'off',
      /*
       * FXServer's stdout is the server log. There is no logger to reach for
       * and no transport to ship to, so console is the correct channel here -
       * unlike everywhere else in the repository, where it is a leftover.
       */
      'no-console': 'off',
    },
  },
];
