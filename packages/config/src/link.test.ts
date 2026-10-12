import { describe, expect, it } from 'vitest';

import { parseLinkEnv } from './link';
import { EnvironmentValidationError } from './parse';

const linkEnv = {
  NODE_ENV: 'production',
  LOG_LEVEL: 'info',
  LINK_DISCORD_TOKEN: 'link-token-for-test',
  LINK_DISCORD_APPLICATION_ID: '22345678901234567',
  DISCORD_GUILD_ID: '12345678901234568',
  NEXT_PUBLIC_SITE_URL: 'https://xenonrp.test',
  CORE_API_URL: 'http://core-api:3300',
  LINK_CORE_SECRET: 'c'.repeat(32),
  LINK_GATEWAY_SECRET: 'g'.repeat(32),
};

function issuesOf(source: Record<string, string | undefined>): string {
  try {
    parseLinkEnv(source);
  } catch (error) {
    expect(error).toBeInstanceOf(EnvironmentValidationError);
    return (error as EnvironmentValidationError).issues.join('\n');
  }
  throw new Error('expected parseLinkEnv to throw');
}

describe('link configuration', () => {
  it('boots without database, Redis, auth, storage or FiveM values and applies defaults', () => {
    const env = parseLinkEnv(linkEnv);
    expect(env.LINK_GATEWAY_HOST).toBe('127.0.0.1');
    expect(env.LINK_GATEWAY_PORT).toBe(8082);
    expect(env.LINK_EVENTS_CHANNEL_ID).toBeUndefined();
    expect(env).not.toHaveProperty('DATABASE_URL');
    expect(env).not.toHaveProperty('REDIS_URL');
  });

  it('defaults the gateway mode to http and accepts relay', () => {
    expect(parseLinkEnv(linkEnv).LINK_GATEWAY_MODE).toBe('http');
    expect(parseLinkEnv({ ...linkEnv, LINK_GATEWAY_MODE: 'relay' }).LINK_GATEWAY_MODE).toBe(
      'relay',
    );
    expect(issuesOf({ ...linkEnv, LINK_GATEWAY_MODE: 'both' })).toMatch(/LINK_GATEWAY_MODE/);
  });

  it('strips datastore credentials even when the host passes them', () => {
    const env = parseLinkEnv({ ...linkEnv, DATABASE_URL: 'postgres://u:p@db/x' });
    expect(env).not.toHaveProperty('DATABASE_URL');
  });

  it('requires every Link credential', () => {
    for (const key of [
      'LINK_DISCORD_TOKEN',
      'LINK_DISCORD_APPLICATION_ID',
      'DISCORD_GUILD_ID',
      'NEXT_PUBLIC_SITE_URL',
      'CORE_API_URL',
      'LINK_CORE_SECRET',
      'LINK_GATEWAY_SECRET',
    ] as const) {
      const env: Record<string, string | undefined> = { ...linkEnv, [key]: undefined };
      expect(issuesOf(env), key).toContain(key);
    }
  });

  it('rejects short service secrets and malformed values', () => {
    expect(issuesOf({ ...linkEnv, LINK_CORE_SECRET: 'short' })).toMatch(/LINK_CORE_SECRET/);
    expect(issuesOf({ ...linkEnv, LINK_GATEWAY_SECRET: 'x'.repeat(31) })).toMatch(
      /LINK_GATEWAY_SECRET/,
    );
    expect(issuesOf({ ...linkEnv, CORE_API_URL: 'ftp://core' })).toMatch(/CORE_API_URL/);
    expect(issuesOf({ ...linkEnv, LINK_EVENTS_CHANNEL_ID: '123' })).toMatch(
      /LINK_EVENTS_CHANNEL_ID/,
    );
    expect(issuesOf({ ...linkEnv, LINK_GATEWAY_PORT: '70000' })).toMatch(/LINK_GATEWAY_PORT/);
  });

  it('treats blank optional channels as unset', () => {
    const env = parseLinkEnv({ ...linkEnv, LINK_STAFF_LOG_CHANNEL_ID: '  ' });
    expect(env.LINK_STAFF_LOG_CHANNEL_ID).toBeUndefined();
  });

  it('refuses to start when Guardian and Link share a token or application id', () => {
    expect(issuesOf({ ...linkEnv, GUARDIAN_DISCORD_TOKEN: linkEnv.LINK_DISCORD_TOKEN })).toMatch(
      /LINK_DISCORD_TOKEN: must differ from GUARDIAN_DISCORD_TOKEN/,
    );
    expect(
      issuesOf({
        ...linkEnv,
        GUARDIAN_DISCORD_APPLICATION_ID: linkEnv.LINK_DISCORD_APPLICATION_ID,
      }),
    ).toMatch(/LINK_DISCORD_APPLICATION_ID: must differ/);
  });

  it('accepts distinct Guardian credentials in the same environment', () => {
    expect(() =>
      parseLinkEnv({
        ...linkEnv,
        GUARDIAN_DISCORD_TOKEN: 'guardian-token-for-test',
        GUARDIAN_DISCORD_APPLICATION_ID: '32345678901234567',
      }),
    ).not.toThrow();
  });
});
