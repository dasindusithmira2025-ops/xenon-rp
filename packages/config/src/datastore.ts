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
