import { describe, expect, it } from 'vitest';

import { parseFivemEnv } from './fivem';
import { EnvironmentValidationError } from './parse';

const secret = 'x'.repeat(32);

function issuesOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(EnvironmentValidationError);
    return (error as EnvironmentValidationError).issues.join('\n');
  }
  throw new Error('expected an EnvironmentValidationError');
}

describe('fivem configuration', () => {
  it('lets development run without a bridge secret (the mock adapter is used)', () => {
    const env = parseFivemEnv({ NODE_ENV: 'development' });
    expect(env.FIVEM_BRIDGE_SECRET).toBeUndefined();
    expect(env.FIVEM_SERVER_URL).toBeUndefined();
  });

  it('requires FIVEM_BRIDGE_SECRET in production', () => {
    expect(issuesOf(() => parseFivemEnv({ NODE_ENV: 'production' }))).toMatch(
      /FIVEM_BRIDGE_SECRET: is required in production/,
    );
  });

  it('treats a blank secret as missing in production', () => {
    expect(
      issuesOf(() => parseFivemEnv({ NODE_ENV: 'production', FIVEM_BRIDGE_SECRET: '   ' })),
    ).toMatch(/FIVEM_BRIDGE_SECRET/);
  });

  it('rejects a secret shorter than 32 characters', () => {
    expect(
      issuesOf(() => parseFivemEnv({ NODE_ENV: 'development', FIVEM_BRIDGE_SECRET: 'short' })),
    ).toMatch(/FIVEM_BRIDGE_SECRET/);
  });

  it('rejects a malformed server URL', () => {
    expect(
      issuesOf(() => parseFivemEnv({ NODE_ENV: 'development', FIVEM_SERVER_URL: 'not a url' })),
    ).toMatch(/FIVEM_SERVER_URL/);
  });

  it('boots production with a secret and does not ask for web OAuth or datastore values', () => {
    const env = parseFivemEnv({
      NODE_ENV: 'production',
      FIVEM_BRIDGE_SECRET: secret,
      FIVEM_SERVER_URL: 'http://127.0.0.1:30120',
    });
    expect(env.FIVEM_BRIDGE_SECRET).toBe(secret);
  });
});
