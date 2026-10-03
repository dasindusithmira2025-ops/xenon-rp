import { botEnv } from '@xenon/config/bot';
import { createLogger, type Logger } from '@xenon/logger';

// Integrated deployments share the repository's root .env. A Discord-only
// process receives its complete environment from the host and must not load
// unrelated database, Redis, Auth.js, storage, or FiveM values from that file.
if (process.env.BOT_RUNTIME_MODE !== 'discord-only') {
  await import('@xenon/config/load-env');
}

/**
 * Process-wide runtime services.
 *
 * Integrated mode loads the root `.env` before configuration is first read.
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
  return (
    botEnv.DISCORD_MODE === 'enabled' &&
    Boolean(botEnv.DISCORD_BOT_TOKEN && botEnv.DISCORD_APPLICATION_ID && botEnv.DISCORD_GUILD_ID)
  );
}

export { botEnv };
