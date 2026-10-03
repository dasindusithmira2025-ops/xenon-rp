import { describe, expect, it } from 'vitest';

import { EnvironmentValidationError } from './parse';
import { parseBotEnv } from './bot';

const discordOnlyEnv = {
  NODE_ENV: 'production',
  LOG_LEVEL: 'info',
  BOT_RUNTIME_MODE: 'discord-only',
  DISCORD_MODE: 'enabled',
  DISCORD_APPLICATION_ID: '12345678901234567',
  DISCORD_BOT_TOKEN: 'discord-token-for-test',
  DISCORD_GUILD_ID: '12345678901234568',
  DISCORD_INVITE_URL: 'https://discord.gg/xenon',
};

describe('bot runtime mode configuration', () => {
  it('boots Discord-only production without database, Redis, auth, website, storage or FiveM values', () => {
    expect(parseBotEnv(discordOnlyEnv).BOT_RUNTIME_MODE).toBe('discord-only');
  });

  it('keeps database and Redis mandatory in integrated production mode', () => {
    let failure: unknown;
    try {
      parseBotEnv({
        ...discordOnlyEnv,
        BOT_RUNTIME_MODE: 'integrated',
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(EnvironmentValidationError);
    expect((failure as EnvironmentValidationError).issues.join('\n')).toMatch(/DATABASE_URL/);
    expect((failure as EnvironmentValidationError).issues.join('\n')).toMatch(/REDIS_URL/);
  });

  it('requires every Discord-only credential', () => {
    for (const key of ['DISCORD_APPLICATION_ID', 'DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID', 'DISCORD_INVITE_URL'] as const) {
      const env = { ...discordOnlyEnv };
      delete env[key];
      expect(() => parseBotEnv(env), key).toThrow(EnvironmentValidationError);
    }
  });

  it('requires production and info logging for Discord-only deployments', () => {
    expect(() => parseBotEnv({ ...discordOnlyEnv, NODE_ENV: 'development' })).toThrow(/NODE_ENV/);
    expect(() => parseBotEnv({ ...discordOnlyEnv, LOG_LEVEL: 'debug' })).toThrow(/LOG_LEVEL/);
  });
});
