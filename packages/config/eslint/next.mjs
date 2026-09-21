import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

import { baseConfig } from './base.mjs';

/** Flat config for the Next.js app: base rules plus React/Next specifics. */
export function nextConfig(tsconfigRootDir) {
  return [
    ...baseConfig(tsconfigRootDir),
    {
      files: ['**/*.{ts,tsx}'],
      languageOptions: {
        globals: { ...globals.browser, ...globals.node },
      },
      plugins: { '@next/next': nextPlugin, 'react-hooks': reactHooks },
      rules: {
        ...nextPlugin.configs.recommended.rules,
        ...nextPlugin.configs['core-web-vitals'].rules,
        ...reactHooks.configs.recommended.rules,

        // Server-only secrets must never be reachable from a client bundle.
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['@xenon/database', '@xenon/database/*'],
                message:
                  'Never import the database client into a component. Go through a server action or service in src/server.',
              },
            ],
          },
        ],
      },
    },
    {
      // Server-side code is allowed to reach for the database directly.
      files: ['src/server/**', 'src/app/api/**', 'src/app/**/actions.ts', 'src/lib/server/**'],
      rules: { 'no-restricted-imports': 'off' },
    },
  ];
}
