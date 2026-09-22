import { lazyEnv, parseEnv } from './parse';
import {
  datastoreSchema,
  discordSchema,
  discordSnowflake,
  fivemSchema,
  integrationsSchema,
  optional,
  requireInProduction,
  runtimeSchema,
  securitySchema,
  siteSchema,
  discordMode,
  validateDiscordMode,
} from './schema';

import type { z } from 'zod';

/**
 * Configuration for the persistent Discord gateway service.
 *
 * Holds the bot token and no OAuth client secret: the bot never performs a
 * user-facing OAuth exchange.
 */
const botSchema = validateDiscordMode(
  requireInProduction(
    runtimeSchema
      .extend(datastoreSchema.shape)
      .extend(securitySchema.shape)
      .extend(discordSchema.shape)
      .extend(integrationsSchema.shape)
      .extend(fivemSchema.shape)
      .extend({
        DISCORD_MODE: discordMode,
        // Public OAuth application ID only; the bot process never receives the
        // OAuth client secret, but can still reject a split application setup.
        AUTH_DISCORD_ID: optional(discordSnowflake),
        NEXT_PUBLIC_SITE_URL: siteSchema.shape.NEXT_PUBLIC_SITE_URL,
      }),
  ),
);

export type BotEnv = z.output<typeof botSchema>;

export const botEnv: BotEnv = lazyEnv(() => parseEnv('bot', botSchema, process.env));
