import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRootEnv } from '@xenon/config/load-env';

/**
 * Point the suite at its own database and bring its schema up to date.
 *
 * A separate database rather than a separate schema: `migrate deploy` and the
 * truncation this suite does between tests are both destructive, and the cost
 * of getting the target wrong is somebody's afternoon of development data.
 * The name is derived from DATABASE_URL, so it follows whatever host, port and
 * credentials the developer already configured.
 */
export function testDatabaseUrl(): string {
  loadRootEnv();

  const source = process.env.DATABASE_URL;
  if (source === undefined || source.length === 0) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env and start the stack with `pnpm dev:up`.',
    );
  }

  const url = new URL(source);
  const name = url.pathname.replace(/^\//, '');
  if (name.endsWith('_test')) return url.toString();

  url.pathname = `/${name}_test`;
  return url.toString();
}

export default function setup(): void {
  const databaseUrl = testDatabaseUrl();
  const databasePackage = join(dirname(fileURLToPath(import.meta.url)), '..', 'database');

  // `migrate deploy` creates the database when it is missing, so there is no
  // separate CREATE DATABASE step to keep in sync with the connection string.
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: databasePackage,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}
