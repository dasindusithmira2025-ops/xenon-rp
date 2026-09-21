import { existsSync } from 'node:fs';
import { dirname, join, parse as parsePath } from 'node:path';

/**
 * Load the monorepo's root `.env` into `process.env`.
 *
 * One `.env` at the repo root rather than one per app: the web tier, the bot
 * and the Prisma CLI all read the same DATABASE_URL, and keeping three copies
 * in sync is a reliable source of "works on my machine".
 *
 * `process.loadEnvFile` leaves already-defined variables alone, so a real
 * environment variable (CI, a container, a platform secret) always wins over
 * the file. Import this module for side effects, as early as possible:
 *
 *   import '@xenon/config/load-env';
 */

/** Walk up from `startDir` looking for the workspace root marker. */
function findWorkspaceRoot(startDir: string): string | undefined {
  const { root } = parsePath(startDir);
  for (let current = startDir; ; current = dirname(current)) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    if (current === root || dirname(current) === current) return undefined;
  }
}

export function loadRootEnv(startDir: string = process.cwd()): string | undefined {
  const workspaceRoot = findWorkspaceRoot(startDir);
  if (workspaceRoot === undefined) return undefined;

  const envPath = join(workspaceRoot, '.env');
  if (!existsSync(envPath)) return undefined;

  process.loadEnvFile(envPath);
  return envPath;
}

loadRootEnv();
