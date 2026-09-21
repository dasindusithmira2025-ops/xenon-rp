import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { e2eDatabaseUrl } from './database';

/**
 * Build the world the suite runs against.
 *
 * Migrations, then an empty database with the baseline back in it, then the
 * development fixtures - the same scripts a developer runs on a fresh clone,
 * in the same order. A bespoke fixture loader here would be a second
 * definition of "what the database looks like" and the first one to go stale.
 */
export default function globalSetup(): void {
  const databaseUrl = e2eDatabaseUrl();
  const databasePackage = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'packages',
    'database',
  );

  const run = (args: string[]): void => {
    execFileSync('pnpm', args, {
      cwd: databasePackage,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  };

  // `migrate deploy` creates the database when it is missing, so there is no
  // separate CREATE DATABASE step. `reset` then empties every row and rebuilds
  // the baseline - emptied rather than dropped, because the suite asserts on
  // counts and leftovers from a previous run would make it pass or fail
  // depending on history.
  run(['exec', 'prisma', 'migrate', 'deploy']);
  run(['run', 'reset']);
  run(['run', 'seed:dev']);
}
