import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { EnvironmentValidationError, lazyEnv, parseEnv } from './parse';
import {
  authSchema,
  discordMode,
  discordSchema,
  requireInProduction,
  runtimeSchema,
  siteSchema,
  storageSchema,
  validateDiscordMode,
} from './schema';

describe('parseEnv', () => {
  const schema = z.object({
    REQUIRED: z.string().min(1),
    WITH_DEFAULT: z.string().default('fallback'),
    NUMERIC: z.coerce.number(),
  });

  it('returns parsed and defaulted values', () => {
    const result = parseEnv('test', schema, { REQUIRED: 'x', NUMERIC: '42' });
    expect(result).toEqual({ REQUIRED: 'x', WITH_DEFAULT: 'fallback', NUMERIC: 42 });
  });

  it('reports every problem at once rather than the first', () => {
    // The whole point: a developer fixes one round of errors instead of
    // discovering them one restart at a time.
    try {
      parseEnv('test', schema, { NUMERIC: 'not-a-number' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentValidationError);
      const issues = (error as EnvironmentValidationError).issues;
      expect(issues).toHaveLength(2);
      expect(issues.join('\n')).toContain('REQUIRED');
      expect(issues.join('\n')).toContain('NUMERIC');
    }
  });

  it('names the scope and points at .env.example', () => {
    try {
      parseEnv('bot', schema, {});
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('Invalid bot environment configuration');
      expect((error as Error).message).toContain('.env.example');
    }
  });
});

describe('lazyEnv', () => {
  it('does not validate until a property is read', () => {
    const factory = vi.fn(() => ({ value: 1 }));
    const env = lazyEnv(factory);
    expect(factory).not.toHaveBeenCalled();

    expect(env.value).toBe(1);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('validates once and caches the result', () => {
    const factory = vi.fn(() => ({ value: 1 }));
    const env = lazyEnv(factory);
    expect(env.value).toBe(1);
    expect(env.value).toBe(1);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('propagates the validation failure on first access, not on construction', () => {
    const env = lazyEnv<{ value: number }>(() => {
      throw new EnvironmentValidationError('test', ['boom']);
    });
    expect(() => env.value).toThrow(EnvironmentValidationError);
  });
});

describe('requireInProduction', () => {
  const schema = requireInProduction(
    runtimeSchema.extend(storageSchema.shape).extend(siteSchema.shape),
  );

  const complete = {
    NODE_ENV: 'production',
    R2_ACCOUNT_ID: 'a',
    R2_ACCESS_KEY: 'b',
    R2_SECRET_KEY: 'c',
    R2_BUCKET: 'd',
    R2_PUBLIC_URL: 'https://cdn.example.com',
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: 'site-key',
    NEXT_PUBLIC_SITE_URL: 'https://example.com',
  };

  it('allows unconfigured integrations outside production', () => {
    const result = schema.safeParse({
      NODE_ENV: 'development',
      NEXT_PUBLIC_SITE_URL: 'http://localhost:3000',
    });
    expect(result.success).toBe(true);
  });

  it('refuses to start production with storage unconfigured', () => {
    // Running production with no bucket would silently write uploads somewhere
    // ephemeral; failing at boot is the whole point.
    const result = schema.safeParse({
      NODE_ENV: 'production',
      NEXT_PUBLIC_SITE_URL: 'https://example.com',
    });
    expect(result.success).toBe(false);
    const paths = result.error?.issues.map((issue) => issue.path.join('.')) ?? [];
    expect(paths).toContain('R2_BUCKET');
    expect(paths).toContain('NEXT_PUBLIC_TURNSTILE_SITE_KEY');
  });

  it('accepts production when everything it guards is present', () => {
    expect(schema.safeParse(complete).success).toBe(true);
  });

  it('only complains about keys the schema actually declares', () => {
    // FIVEM_BRIDGE_SECRET is on the production-required list but is not part of
    // this schema, so it must not surface as a phantom error here.
    const paths =
      schema
        .safeParse({ NODE_ENV: 'production', NEXT_PUBLIC_SITE_URL: 'https://example.com' })
        .error?.issues.map((issue) => issue.path.join('.')) ?? [];
    expect(paths).not.toContain('FIVEM_BRIDGE_SECRET');
  });
});

describe('Discord configuration', () => {
  const schema = validateDiscordMode(
    runtimeSchema.extend(authSchema.shape).extend(discordSchema.shape).extend({
      DISCORD_MODE: discordMode,
      NEXT_PUBLIC_SITE_URL: siteSchema.shape.NEXT_PUBLIC_SITE_URL,
    }),
  );

  const configured = {
    NODE_ENV: 'development',
    DISCORD_MODE: 'enabled',
    AUTH_SECRET: 'x'.repeat(32),
    AUTH_DISCORD_ID: '12345678901234567',
    AUTH_DISCORD_SECRET: 'rotated-secret',
    AUTH_URL: 'http://localhost:3200/api/auth',
    DISCORD_APPLICATION_ID: '12345678901234567',
    DISCORD_BOT_TOKEN: 'rotated-bot-token',
    DISCORD_GUILD_ID: '23456789012345678',
    NEXT_PUBLIC_SITE_URL: 'http://localhost:3200',
  };

  it('allows an explicit disabled development environment with blank credentials', () => {
    expect(
      schema.safeParse({
        NODE_ENV: 'development',
        DISCORD_MODE: 'disabled',
        AUTH_SECRET: 'x'.repeat(32),
        NEXT_PUBLIC_SITE_URL: 'http://localhost:3200',
      }).success,
    ).toBe(true);
  });

  it('requires one matching application id for OAuth and the bot', () => {
    const result = schema.safeParse({
      ...configured,
      DISCORD_APPLICATION_ID: '34567890123456789',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path[0] === 'DISCORD_APPLICATION_ID')).toBe(
      true,
    );
  });

  it('requires complete OAuth and bot credentials when enabled', () => {
    const result = schema.safeParse({
      NODE_ENV: 'development',
      DISCORD_MODE: 'enabled',
      AUTH_SECRET: 'x'.repeat(32),
      NEXT_PUBLIC_SITE_URL: 'http://localhost:3200',
    });
    expect(result.success).toBe(false);
    const paths = result.error?.issues.map((issue) => issue.path[0]);
    expect(paths).toContain('AUTH_DISCORD_ID');
    expect(paths).toContain('DISCORD_BOT_TOKEN');
  });

  it('requires the canonical callback origin in production', () => {
    const result = schema.safeParse({
      ...configured,
      NODE_ENV: 'production',
      AUTH_URL: 'https://auth.example.com/api/auth',
      NEXT_PUBLIC_SITE_URL: 'https://xenon.example.com',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path[0] === 'AUTH_URL')).toBe(true);
  });

  it('reports a malformed callback origin as configuration instead of throwing a URL exception', () => {
    const result = schema.safeParse({ ...configured, AUTH_URL: 'http://' });

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path[0] === 'AUTH_URL')).toBe(true);
  });
});
