import { loadRootEnv } from '@xenon/config/load-env';

/**
 * The database the E2E suite owns.
 *
 * Derived from DATABASE_URL with an `_e2e` suffix, following whatever host,
 * port and credentials the developer already configured. Separate from both
 * the development database and the integration suite's `_test` one, because
 * this suite wipes it and reseeds it on every run.
 */
export function e2eDatabaseUrl(): string {
  loadRootEnv();

  const source = process.env.DATABASE_URL;
  if (source === undefined || source.length === 0) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env and start the stack with `pnpm dev:up`.',
    );
  }

  const url = new URL(source);
  const name = url.pathname.replace(/^\//, '').replace(/_(test|e2e)$/, '');
  url.pathname = `/${name}_e2e`;
  return url.toString();
}
