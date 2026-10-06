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
  discordInviteUrl,
} from './schema';

import { z } from 'zod';

/**
 * Configuration for the persistent Discord gateway service.
 *
 * Holds the bot token and no OAuth client secret: the bot never performs a
 * user-facing OAuth exchange.
 */
const integratedBotSchema = validateDiscordMode(
  requireInProduction(
    runtimeSchema
      .extend(datastoreSchema.shape)
      .extend(securitySchema.shape)
      .extend(discordSchema.shape)
      .extend(integrationsSchema.shape)
      .extend(fivemSchema.shape)
      .extend({
        BOT_RUNTIME_MODE: z.enum(['integrated', 'discord-only']).default('integrated'),
        DISCORD_MODE: discordMode,
        DISCORD_INVITE_URL: discordInviteUrl,
        // Public OAuth application ID only; the bot process never receives the
        // OAuth client secret, but can still reject a split application setup.
        AUTH_DISCORD_ID: optional(discordSnowflake),
        NEXT_PUBLIC_SITE_URL: siteSchema.shape.NEXT_PUBLIC_SITE_URL,
      }),
  ),
);

const discordOnlyBotSchema = runtimeSchema.extend({
  NODE_ENV: z.literal('production'),
  LOG_LEVEL: z.literal('info'),
  BOT_RUNTIME_MODE: z.literal('discord-only'),
  DISCORD_MODE: z.literal('enabled'),
  DISCORD_APPLICATION_ID: discordSnowflake,
  DISCORD_BOT_TOKEN: z.string().trim().min(1),
  DISCORD_GUILD_ID: discordSnowflake,
  DISCORD_INVITE_URL: z.url(),
  /** Optional: only used for the ticket panel's website button. */
  NEXT_PUBLIC_SITE_URL: optional(z.url()),
});

export type BotEnv = z.output<typeof integratedBotSchema>;

/** Select the narrow Discord-only contract before parsing integrated secrets. */
export function parseBotEnv(source: Record<string, string | undefined>): BotEnv {
  if (source.BOT_RUNTIME_MODE === 'discord-only') {
    return parseEnv('bot', discordOnlyBotSchema, source) as BotEnv;
  }
  return parseEnv('bot', integratedBotSchema, source);
}

export const botEnv: BotEnv = lazyEnv(() => parseBotEnv(process.env));
