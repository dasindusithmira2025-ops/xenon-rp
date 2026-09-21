import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { EnvironmentValidationError, lazyEnv, parseEnv } from './parse';
import { requireInProduction, runtimeSchema, siteSchema, storageSchema } from './schema';

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
