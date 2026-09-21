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
      /*
       * React Compiler purity rules do not apply to server components.
       *
       * `react-hooks/purity` forbids `Date.now()` during render because a
       * client component that reads the clock while rendering produces output
       * React cannot reconcile. A server component renders once, on the server,
       * to produce HTML - reading the clock there is the only way to answer
       * "how long has this been waiting", and there is no reconciliation to
       * break.
       *
       * Scoped to files that cannot carry 'use client': a component under
       * src/components keeps the rule.
       */
      files: ['src/app/**/page.tsx', 'src/app/**/layout.tsx'],
      rules: { 'react-hooks/purity': 'off' },
    },
    {
      /*
       * Server-only surfaces may reach for the database directly.
       *
       * In the App Router a page, layout, route handler or metadata file is a
       * server module by default, so the thing this rule exists to prevent -
       * the Prisma client ending up in a browser bundle - cannot happen there.
       * The rule still applies to everything under src/components, which is
       * where client components actually live and where the mistake would
       * otherwise be made.
       */
      files: [
        'src/server/**',
        'src/lib/server/**',
        'src/app/api/**',
        'src/app/**/actions.ts',
        'src/app/**/page.tsx',
        'src/app/**/layout.tsx',
        'src/app/**/route.ts',
        'src/app/**/opengraph-image.tsx',
        'src/app/sitemap.ts',
        'src/app/robots.ts',
      ],
      rules: { 'no-restricted-imports': 'off' },
    },
  ];
}
