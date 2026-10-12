import { describe, expect, it } from 'vitest';

import { parseGuardianEnv } from './guardian';
import { EnvironmentValidationError } from './parse';

const guardianEnv = {
  NODE_ENV: 'production',
  LOG_LEVEL: 'info',
  GUARDIAN_DISCORD_APPLICATION_ID: '12345678901234567',
  GUARDIAN_DISCORD_TOKEN: 'guardian-token-for-test',
  DISCORD_GUILD_ID: '12345678901234568',
  DISCORD_INVITE_URL: 'https://discord.gg/xenon',
};

function issuesOf(source: Record<string, string | undefined>): string {
  try {
    parseGuardianEnv(source);
  } catch (error) {
    expect(error).toBeInstanceOf(EnvironmentValidationError);
    return (error as EnvironmentValidationError).issues.join('\n');
  }
  throw new Error('expected Guardian configuration to be rejected');
}

describe('Guardian configuration', () => {
  it('boots without database, Redis, auth, Core, Link, storage or FiveM values', () => {
    const env = parseGuardianEnv(guardianEnv);
    expect(env).toMatchObject({
      GUARDIAN_DISCORD_TOKEN: 'guardian-token-for-test',
      GUARDIAN_HEALTH_HOST: '127.0.0.1',
      GUARDIAN_HEALTH_PORT: 8081,
    });
    expect(env.NEXT_PUBLIC_SITE_URL).toBeUndefined();
  });

  it('ignores platform secrets present in a shared environment instead of exposing them', () => {
    const env = parseGuardianEnv({
      ...guardianEnv,
      DATABASE_URL: 'not-a-url',
      REDIS_URL: 'redis://localhost:6379',
      AUTH_SECRET: 'x',
      FIVEM_BRIDGE_SECRET: 'y',
      LINK_CORE_SECRET: 'z',
      LINK_DISCORD_TOKEN: 'link-token-for-test',
      LINK_DISCORD_APPLICATION_ID: '22345678901234567',
    });
    for (const key of [
      'DATABASE_URL',
      'REDIS_URL',
      'AUTH_SECRET',
      'FIVEM_BRIDGE_SECRET',
      'LINK_CORE_SECRET',
      'LINK_DISCORD_TOKEN',
      'LINK_DISCORD_APPLICATION_ID',
    ])
      expect(env, key).not.toHaveProperty(key);
  });

  it('requires every Guardian credential', () => {
    for (const key of [
      'GUARDIAN_DISCORD_APPLICATION_ID',
      'GUARDIAN_DISCORD_TOKEN',
      'DISCORD_GUILD_ID',
      'DISCORD_INVITE_URL',
    ] as const) {
      const env = { ...guardianEnv, [key]: undefined };
      expect(issuesOf(env), key).toContain(key);
    }
    expect(issuesOf({ ...guardianEnv, GUARDIAN_DISCORD_TOKEN: '   ' })).toContain(
      'GUARDIAN_DISCORD_TOKEN',
    );
  });

  it('does not accept the legacy single-bot variable names', () => {
    const legacy: Record<string, string | undefined> = {
      ...guardianEnv,
      DISCORD_BOT_TOKEN: guardianEnv.GUARDIAN_DISCORD_TOKEN,
      DISCORD_APPLICATION_ID: guardianEnv.GUARDIAN_DISCORD_APPLICATION_ID,
    };
    delete legacy.GUARDIAN_DISCORD_TOKEN;
    delete legacy.GUARDIAN_DISCORD_APPLICATION_ID;
    const issues = issuesOf(legacy);
    expect(issues).toContain('GUARDIAN_DISCORD_TOKEN');
    expect(issues).toContain('GUARDIAN_DISCORD_APPLICATION_ID');
  });

  it('requires production and info logging', () => {
    expect(issuesOf({ ...guardianEnv, NODE_ENV: 'development' })).toContain('NODE_ENV');
    expect(issuesOf({ ...guardianEnv, LOG_LEVEL: 'debug' })).toContain('LOG_LEVEL');
  });

  it('validates the health endpoint port', () => {
    expect(
      parseGuardianEnv({ ...guardianEnv, GUARDIAN_HEALTH_PORT: '9000' }).GUARDIAN_HEALTH_PORT,
    ).toBe(9000);
    for (const port of ['0', '65536', 'abc', '80.5'])
      expect(issuesOf({ ...guardianEnv, GUARDIAN_HEALTH_PORT: port }), port).toContain(
        'GUARDIAN_HEALTH_PORT',
      );
  });

  it('refuses to share a token or application id with Xenon Link', () => {
    expect(
      issuesOf({ ...guardianEnv, LINK_DISCORD_TOKEN: guardianEnv.GUARDIAN_DISCORD_TOKEN }),
    ).toMatch(/GUARDIAN_DISCORD_TOKEN: must differ from LINK_DISCORD_TOKEN/);
    expect(
      issuesOf({
        ...guardianEnv,
        LINK_DISCORD_APPLICATION_ID: guardianEnv.GUARDIAN_DISCORD_APPLICATION_ID,
      }),
    ).toMatch(/GUARDIAN_DISCORD_APPLICATION_ID: must differ from LINK_DISCORD_APPLICATION_ID/);
    expect(
      issuesOf({ ...guardianEnv, LINK_DISCORD_TOKEN: ` ${guardianEnv.GUARDIAN_DISCORD_TOKEN} ` }),
    ).toContain('LINK_DISCORD_TOKEN');
  });
});
