import { describe, expect, it } from 'vitest';

import { EnvironmentValidationError } from './parse';
import { linkGatewayTarget, parseWorkerEnv } from './worker';

const workerEnv = {
  NODE_ENV: 'production',
  LOG_LEVEL: 'info',
  DATABASE_URL: 'postgresql://xenon:xenon@db:5432/xenon',
  REDIS_URL: 'redis://redis:6379',
  HASH_PEPPER: 'p'.repeat(32),
  NEXT_PUBLIC_SITE_URL: 'https://xenonrp.test',
  DISCORD_GUILD_ID: '12345678901234568',
  LINK_GATEWAY_URL: 'http://link-bot:8082',
  LINK_GATEWAY_SECRET: 'g'.repeat(32),
  FIVEM_BRIDGE_SECRET: 'f'.repeat(32),
};

function issuesOf(source: Record<string, string | undefined>): string {
  try {
    parseWorkerEnv(source);
  } catch (error) {
    expect(error).toBeInstanceOf(EnvironmentValidationError);
    return (error as EnvironmentValidationError).issues.join('\n');
  }
  throw new Error('expected parseWorkerEnv to throw');
}

describe('worker configuration', () => {
  it('applies the health listener defaults and never carries a Discord token', () => {
    const env = parseWorkerEnv({ ...workerEnv, LINK_DISCORD_TOKEN: 'never-read' });
    expect(env.WORKER_HEALTH_HOST).toBe('127.0.0.1');
    expect(env.WORKER_HEALTH_PORT).toBe(8083);
    expect(env).not.toHaveProperty('LINK_DISCORD_TOKEN');
    expect(env).not.toHaveProperty('GUARDIAN_DISCORD_TOKEN');
  });

  it('requires the datastore, guild and gateway settings', () => {
    for (const key of [
      'DATABASE_URL',
      'REDIS_URL',
      'NEXT_PUBLIC_SITE_URL',
      'DISCORD_GUILD_ID',
      'LINK_GATEWAY_URL',
      'LINK_GATEWAY_SECRET',
    ] as const) {
      const env = Object.fromEntries(Object.entries(workerEnv).filter(([name]) => name !== key));
      expect(issuesOf(env), key).toContain(key);
    }
  });

  it('requires the FiveM bridge secret in production only', () => {
    const { FIVEM_BRIDGE_SECRET: _secret, ...withoutBridge } = workerEnv;
    expect(issuesOf(withoutBridge)).toMatch(/FIVEM_BRIDGE_SECRET/);
    expect(() => parseWorkerEnv({ ...withoutBridge, NODE_ENV: 'development' })).not.toThrow();
  });

  it('rejects short secrets, a malformed guild and a non-HTTP gateway', () => {
    expect(issuesOf({ ...workerEnv, LINK_GATEWAY_SECRET: 'short' })).toMatch(/LINK_GATEWAY_SECRET/);
    expect(issuesOf({ ...workerEnv, FIVEM_BRIDGE_SECRET: 'short' })).toMatch(/FIVEM_BRIDGE_SECRET/);
    expect(issuesOf({ ...workerEnv, DISCORD_GUILD_ID: 'not-a-guild' })).toMatch(/DISCORD_GUILD_ID/);
    expect(issuesOf({ ...workerEnv, LINK_GATEWAY_URL: 'ftp://link-bot' })).toMatch(
      /LINK_GATEWAY_URL/,
    );
  });

  it('defaults to http mode, which requires LINK_GATEWAY_URL', () => {
    const { LINK_GATEWAY_URL: _url, ...withoutUrl } = workerEnv;
    expect(parseWorkerEnv(workerEnv).LINK_GATEWAY_MODE).toBe('http');
    expect(issuesOf(withoutUrl)).toMatch(/LINK_GATEWAY_URL: is required when LINK_GATEWAY_MODE=http/);
    expect(issuesOf({ ...withoutUrl, LINK_GATEWAY_URL: '  ' })).toMatch(/LINK_GATEWAY_URL/);
  });

  it('relay mode parses without a URL and rejects unknown modes', () => {
    const { LINK_GATEWAY_URL: _url, ...withoutUrl } = workerEnv;
    const env = parseWorkerEnv({ ...withoutUrl, LINK_GATEWAY_MODE: 'relay' });
    expect(env.LINK_GATEWAY_MODE).toBe('relay');
    expect(env.LINK_GATEWAY_URL).toBeUndefined();
    expect(issuesOf({ ...workerEnv, LINK_GATEWAY_MODE: 'both' })).toMatch(/LINK_GATEWAY_MODE/);
  });

  it('resolves the gateway target', () => {
    expect(linkGatewayTarget(parseWorkerEnv(workerEnv))).toEqual({
      mode: 'http',
      url: 'http://link-bot:8082',
    });
    expect(linkGatewayTarget(parseWorkerEnv({ ...workerEnv, LINK_GATEWAY_MODE: 'relay' }))).toEqual(
      { mode: 'relay' },
    );
    const inconsistent = { ...parseWorkerEnv(workerEnv), LINK_GATEWAY_URL: undefined };
    expect(() => linkGatewayTarget(inconsistent)).toThrow(EnvironmentValidationError);
  });
});
