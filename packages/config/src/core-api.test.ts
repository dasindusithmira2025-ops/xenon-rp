import { describe, expect, it } from 'vitest';

import { parseCoreApiEnv } from './core-api';
import { EnvironmentValidationError } from './parse';

const coreEnv = {
  NODE_ENV: 'production',
  LOG_LEVEL: 'info',
  DATABASE_URL: 'postgresql://xenon:xenon@db:5432/xenon',
  REDIS_URL: 'redis://redis:6379',
  HASH_PEPPER: 'p'.repeat(32),
  NEXT_PUBLIC_SITE_URL: 'https://xenonrp.test',
  LINK_CORE_SECRET: 'c'.repeat(32),
};

function issuesOf(source: Record<string, string | undefined>): string {
  try {
    parseCoreApiEnv(source);
  } catch (error) {
    expect(error).toBeInstanceOf(EnvironmentValidationError);
    return (error as EnvironmentValidationError).issues.join('\n');
  }
  throw new Error('expected parseCoreApiEnv to throw');
}

describe('core-api configuration', () => {
  it('applies the listener defaults and carries no Discord or FiveM credential', () => {
    const env = parseCoreApiEnv({
      ...coreEnv,
      LINK_DISCORD_TOKEN: 'never-read',
      FIVEM_BRIDGE_SECRET: 'f'.repeat(32),
    });
    expect(env.CORE_API_HOST).toBe('127.0.0.1');
    expect(env.CORE_API_PORT).toBe(3300);
    expect(env).not.toHaveProperty('LINK_DISCORD_TOKEN');
    expect(env).not.toHaveProperty('FIVEM_BRIDGE_SECRET');
  });

  it('requires the datastore, site URL and Link secret', () => {
    for (const key of [
      'DATABASE_URL',
      'REDIS_URL',
      'NEXT_PUBLIC_SITE_URL',
      'LINK_CORE_SECRET',
    ] as const) {
      const env = Object.fromEntries(Object.entries(coreEnv).filter(([name]) => name !== key));
      expect(issuesOf(env), key).toContain(key);
    }
  });

  it('rejects a short service secret', () => {
    expect(issuesOf({ ...coreEnv, LINK_CORE_SECRET: 'x'.repeat(31) })).toMatch(/LINK_CORE_SECRET/);
  });

  it('requires the hashing pepper in production only', () => {
    const { HASH_PEPPER: _pepper, ...withoutPepper } = coreEnv;
    expect(issuesOf(withoutPepper)).toMatch(/HASH_PEPPER/);
    expect(() => parseCoreApiEnv({ ...withoutPepper, NODE_ENV: 'development' })).not.toThrow();
  });

  it('rejects an out-of-range port', () => {
    expect(issuesOf({ ...coreEnv, CORE_API_PORT: '70000' })).toMatch(/CORE_API_PORT/);
  });
});
