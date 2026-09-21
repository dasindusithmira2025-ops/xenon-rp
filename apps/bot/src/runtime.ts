import '@xenon/config/load-env';

import { botEnv } from '@xenon/config/bot';
import { createLogger, type Logger } from '@xenon/logger';

/**
 * Process-wide runtime services.
 *
 * Imported for its side effect of loading the root `.env` before anything else
 * reads configuration - the bot, the web tier and the Prisma CLI all share one
 * file so a connection string cannot be right in one place and stale in
 * another.
 */

export const logger: Logger = createLogger({
  service: 'bot',
  level: botEnv.LOG_LEVEL,
  pretty: botEnv.NODE_ENV !== 'production',
});

/**
 * Whether the Discord credentials are real.
 *
 * A fresh clone runs with placeholder values so the stack boots without anyone
 * creating a Discord application first. In that state the gateway is not
 * connected and Discord-bound jobs complete as logged no-ops rather than
 * retrying forever against a token that will never work.
 *
 * This is deliberately not "did login succeed". A real token that is
 * temporarily rejected - an outage, a rate limit, a revoked-and-reissued
 * secret - must keep retrying, because those jobs carry decisions that have
 * already been committed.
 */
export function hasRealDiscordCredentials(): boolean {
  const token = botEnv.DISCORD_BOT_TOKEN;
  const guildId = botEnv.DISCORD_GUILD_ID;

  return token.length > 20 && !token.toLowerCase().includes('placeholder') && !/^0+$/.test(guildId);
}

export { botEnv };
