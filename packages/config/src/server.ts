import { lazyEnv, parseEnv } from './parse';
import {
  authSchema,
  datastoreSchema,
  discordSnowflake,
  fivemSchema,
  integrationsSchema,
  requireInProduction,
  runtimeSchema,
  siteSchema,
  storageSchema,
} from './schema';

import type { z } from 'zod';

/**
 * Configuration for the Next.js server runtime.
 *
 * Deliberately excludes DISCORD_BOT_TOKEN: the web tier never talks to the
 * Discord Gateway or the bot's REST identity. It enqueues jobs that the bot
 * process performs, which keeps the most sensitive credential in one process.
 */
const webServerSchema = requireInProduction(
  runtimeSchema
    .extend(datastoreSchema.shape)
    .extend(authSchema.shape)
    .extend({
      DISCORD_GUILD_ID: discordSnowflake,
      DISCORD_APPLICATION_ID: discordSnowflake,
    })
    .extend(storageSchema.shape)
    .extend(integrationsSchema.shape)
    .extend(fivemSchema.shape)
    .extend(siteSchema.shape),
);

export type ServerEnv = z.output<typeof webServerSchema>;

export const serverEnv: ServerEnv = lazyEnv(() =>
  parseEnv('web server', webServerSchema, process.env),
);

/** True when every credential the media pipeline needs is present. */
export function hasObjectStorage(env: ServerEnv = serverEnv): boolean {
  return Boolean(
    env.R2_ACCOUNT_ID &&
    env.R2_ACCESS_KEY &&
    env.R2_SECRET_KEY &&
    env.R2_BUCKET &&
    env.R2_PUBLIC_URL,
  );
}

/** True when the FiveM bridge can be reached and requests can be signed. */
export function hasFivemBridge(env: ServerEnv = serverEnv): boolean {
  return Boolean(env.FIVEM_BRIDGE_SECRET && env.FIVEM_SERVER_URL);
}

/** True when public abuse-sensitive forms should render a Turnstile challenge. */
export function hasTurnstile(env: ServerEnv = serverEnv): boolean {
  return Boolean(env.TURNSTILE_SECRET && env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);
}
