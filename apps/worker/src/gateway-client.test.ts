import { describe, expect, it } from 'vitest';

import { verifyServiceRequest } from '@xenon/contracts';

import {
  createGatewayClient,
  DiscordRequestError,
  GatewayError,
  isPermanentFailure,
} from './gateway-client';
import { gatewayRolePort } from './ports';

const SECRET = 'g'.repeat(48);

function fakeLink(respond: (path: string) => unknown) {
  const calls: { path: string; verified: boolean }[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const headers = init.headers as Record<string, string>;
    const verified = verifyServiceRequest(
      SECRET,
      { service: 'worker', method: 'POST', path },
      init.body as string,
      (name) => headers[name] ?? null,
    ).ok;
    calls.push({ path, verified });
    return Promise.resolve(new Response(JSON.stringify(respond(path))));
  }) as typeof fetch;
  return {
    calls,
    client: createGatewayClient({ baseUrl: 'http://link:8082/', secret: SECRET, fetch: fetchImpl }),
  };
}

describe('Link gateway client', () => {
  it('signs each call as the worker service for the exact operation path', async () => {
    const link = fakeLink(() => ({ ok: true, data: { roleIds: ['123456789012345678'] } }));

    const result = await link.client('member.roles', { discordUserId: '223456789012345678' });

    expect(result.roleIds).toEqual(['123456789012345678']);
    expect(link.calls).toEqual([{ path: '/gateway/v1/member.roles', verified: true }]);
  });

  it('carries Discord error codes so role-sync classification still works', async () => {
    const link = fakeLink(() => ({
      ok: false,
      error: {
        code: 'DISCORD_ERROR',
        message: 'Missing Permissions',
        retryable: false,
        discordCode: 50013,
      },
    }));

    const error = await link
      .client('guild.info', {})
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DiscordRequestError);
    expect((error as DiscordRequestError).code).toBe(50013);
    expect(isPermanentFailure(error)).toBe(true);
  });

  it('treats an unreachable or unready Link as retryable', async () => {
    const down = createGatewayClient({
      baseUrl: 'http://link:8082',
      secret: SECRET,
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    const unready = fakeLink(() => ({
      ok: false,
      error: { code: 'DISCORD_UNAVAILABLE', message: 'Gateway not ready', retryable: true },
    }));

    const errors = await Promise.all([
      down('guild.info', {}).catch((caught: unknown) => caught),
      unready.client('guild.info', {}).catch((caught: unknown) => caught),
    ]);

    for (const error of errors) {
      expect(error).toBeInstanceOf(GatewayError);
      expect(isPermanentFailure(error)).toBe(false);
    }
  });

  it('reports a refused role target as a permanent missing-permission to role sync', async () => {
    const link = fakeLink(() => ({
      ok: false,
      error: { code: 'FORBIDDEN_TARGET', message: 'Role carries Administrator', retryable: false },
    }));

    const error = await gatewayRolePort(link.client)
      .addRole('223456789012345678', '323456789012345678')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DiscordRequestError);
    expect((error as DiscordRequestError).code).toBe(50013);
    expect(isPermanentFailure(error)).toBe(true);
  });
});
