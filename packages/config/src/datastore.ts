import { lazyEnv, parseEnv } from './parse';
import { datastoreSchema, securitySchema } from './schema';

import type { z } from 'zod';

/**
 * Configuration shared by every runtime.
 *
 * The web tier, the bot and the CLI scripts all need the datastore URLs and the
 * hashing pepper, and none of them should have to accept the others' schema to
 * get at them - the bot has no AUTH_DISCORD_SECRET and the web tier has no
 * DISCORD_BOT_TOKEN. Splitting this out is what lets a low-level package like
 * `@xenon/jobs` read REDIS_URL without dragging in the whole web contract.
 */

const sharedSchema = datastoreSchema.extend(securitySchema.shape);

export type DatastoreEnv = z.output<typeof sharedSchema>;

export const datastoreEnv: DatastoreEnv = lazyEnv(() =>
  parseEnv('datastore', sharedSchema, process.env),
);

/**
 * True when this process is running against production.
 *
 * Here rather than at each call site so that scripts and low-level packages
 * have one sanctioned way to ask, instead of reaching for `process.env`
 * directly and drifting on what counts as production.
 */
export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}
