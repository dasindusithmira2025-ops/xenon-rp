import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';
import turbo from 'eslint-plugin-turbo';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * Shared flat config for every TypeScript package in the monorepo.
 * `tsconfigRootDir` must be supplied by the consuming package so that
 * type-aware rules resolve against that package's own tsconfig.
 */
export function baseConfig(tsconfigRootDir) {
  return tseslint.config(
    {
      // Flat-config and build files are not part of any tsconfig project, so
      // type-aware linting cannot parse them.
      ignores: ['dist/**', '.next/**', '.turbo/**', 'coverage/**', 'generated/**', '**/*.mjs', '**/*.cjs', '*.config.*'],
    },
    js.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
    {
      languageOptions: {
        globals: { ...globals.node },
        parserOptions: {
          projectService: true,
          tsconfigRootDir,
        },
      },
      plugins: { 'import-x': importX, turbo },
      rules: {
        // The house rules the brief calls out: no `any`, no unsafe casts,
        // exhaustive handling of domain unions.
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/no-unsafe-assignment': 'error',
        '@typescript-eslint/no-unsafe-member-access': 'error',
        '@typescript-eslint/no-unsafe-call': 'error',
        '@typescript-eslint/no-unsafe-return': 'error',
        '@typescript-eslint/no-unsafe-argument': 'error',
        '@typescript-eslint/switch-exhaustiveness-check': 'error',
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
        ],
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
        ],
        '@typescript-eslint/require-await': 'error',
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/restrict-template-expressions': [
          'error',
          { allowNumber: true, allowBoolean: false, allowNullish: false },
        ],

        // Secrets and config must flow through @xenon/config, never process.env.
        'no-restricted-properties': [
          'error',
          {
            object: 'process',
            property: 'env',
            message:
              'Read configuration from @xenon/config (validated env) instead of process.env directly.',
          },
        ],
        'no-console': ['error', { allow: ['warn', 'error'] }],
        'no-restricted-syntax': [
          'error',
          {
            selector: "CallExpression[callee.name='alert']",
            message: 'Use the toast/dialog primitives from @xenon/ui, never window.alert().',
          },
        ],

        'import-x/no-duplicates': 'error',
        'import-x/order': [
          'error',
          {
            groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type'],
            pathGroups: [{ pattern: '@xenon/**', group: 'internal', position: 'before' }],
            pathGroupsExcludedImportTypes: ['builtin'],
            'newlines-between': 'always',
            alphabetize: { order: 'asc', caseInsensitive: true },
          },
        ],

        'turbo/no-undeclared-env-vars': 'error',
      },
    },
    {
      // Env validation and bootstrap files are the one place process.env is legal.
      files: ['**/env.ts', '**/env/*.ts', '**/*.config.*', '**/scripts/**'],
      rules: { 'no-restricted-properties': 'off' },
    },
    {
      files: ['**/*.test.ts', '**/*.test.tsx', '**/tests/**', '**/e2e/**'],
      rules: {
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/unbound-method': 'off',
        'no-restricted-properties': 'off',
      },
    },
    prettier,
  );
}
