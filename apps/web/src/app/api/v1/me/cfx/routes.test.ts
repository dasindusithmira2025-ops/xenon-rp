import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CfxLinkError } from '@xenon/fivem';
import type { Actor } from '@xenon/permissions';

import { POST as postAuthorize } from './authorize/route';
import { GET as getCallback } from './callback/route';
import { POST as postUnlink } from './unlink/route';

/**
 * Route-layer behaviour of "Connect Cfx.re": who is turned away, what the
 * browser is told, and what never leaves the server. The protocol itself
 * (nonce, binding, single use, conflicts) is covered against a real database
 * in packages/integration-tests/src/cfx-linking.test.ts.
 */

const mocks = vi.hoisted(() => ({
  currentActor: vi.fn<() => Promise<Actor>>(),
  startCfxLink: vi.fn(),
  completeCfxLink: vi.fn(),
  unlinkCfxAccount: vi.fn(),
  cookie: { value: undefined as string | undefined },
}));

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: () => (mocks.cookie.value === undefined ? undefined : { value: mocks.cookie.value }),
    }),
}));
vi.mock('@xenon/config/public', () => ({
  publicEnv: { NEXT_PUBLIC_SITE_URL: 'https://xenon.test' },
}));
vi.mock('@xenon/config/server', () => ({
  serverEnv: {
    NODE_ENV: 'production',
    NEXT_PUBLIC_SITE_URL: 'https://xenon.test',
    CFX_FORUM_URL: 'https://forum.cfx.re',
    CFX_APP_NAME: 'Xenon Roleplay',
    AUTH_SECRET: 'x'.repeat(44),
  },
}));
vi.mock('~/server/context', () => ({ currentActor: mocks.currentActor }));
vi.mock('@xenon/database', () => ({ prisma: {} }));
vi.mock('@xenon/fivem', async () => {
  // vi.mock factories are hoisted above static imports, so the base class has
  // to be loaded here rather than imported at the top of the file.
  const { ConflictError } = await import('@xenon/core');
  class CfxLinkError extends ConflictError {
    constructor(readonly reason: string) {
      super(`refused: ${reason}`, 'refused');
    }
  }
  return {
    CfxLinkError,
    startCfxLink: mocks.startCfxLink,
    completeCfxLink: mocks.completeCfxLink,
    unlinkCfxAccount: mocks.unlinkCfxAccount,
    httpCfxForum: () => ({}),
  };
});

function actor(userId: string | null): Actor {
  return {
    userId,
    publicId: userId === null ? null : 'XN-10001',
    label: 'fixture',
    source: 'WEB',
    permissions: new Set(),
    roleKeys: new Set(),
  };
}

function form(path: string, origin: string | null, fields: Record<string, string> = {}): Request {
  return new Request(`https://xenon.test${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(origin === null ? {} : { origin }),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookie.value = undefined;
  mocks.currentActor.mockResolvedValue(actor('user_1'));
});

describe('POST /api/v1/me/cfx/authorize', () => {
  it('sends the browser to forum.cfx.re with an httpOnly, scoped binding cookie', async () => {
    mocks.startCfxLink.mockResolvedValue({
      authorizeUrl: 'https://forum.cfx.re/user-api-key/new?nonce=n',
      cookie: 'attempt0000001.secret',
      expiresAt: new Date(Date.now() + 600_000),
    });

    const response = await postAuthorize(form('/api/v1/me/cfx/authorize', 'https://xenon.test'));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://forum.cfx.re/user-api-key/new?nonce=n');
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('xenon_cfx_link=attempt0000001.secret');
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toContain('Path=/api/v1/me/cfx');
    const config = mocks.startCfxLink.mock.calls[0]?.[2] as { callbackUrl: string };
    expect(config.callbackUrl).toBe('https://xenon.test/api/v1/me/cfx/callback');
  });

  it('refuses a cross-site form post before starting anything', async () => {
    const response = await postAuthorize(form('/api/v1/me/cfx/authorize', 'https://evil.test'));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://xenon.test/portal/account?cfx=error');
    expect(mocks.startCfxLink).not.toHaveBeenCalled();
  });

  it('refuses a signed-out visitor', async () => {
    mocks.currentActor.mockResolvedValue(actor(null));
    const response = await postAuthorize(form('/api/v1/me/cfx/authorize', 'https://xenon.test'));
    expect(response.headers.get('location')).toContain('cfx=signin');
    expect(mocks.startCfxLink).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/me/cfx/callback', () => {
  const callback = (payload: string | null) =>
    new Request(
      `https://xenon.test/api/v1/me/cfx/callback${payload === null ? '' : `?payload=${encodeURIComponent(payload)}`}`,
    );

  it('sends a signed-out visitor to sign in, without touching the attempt', async () => {
    mocks.currentActor.mockResolvedValue(actor(null));
    const response = await getCallback(callback('encrypted'));
    expect(response.headers.get('location')).toBe(
      'https://xenon.test/signin?callbackUrl=%2Fportal%2Faccount',
    );
    expect(mocks.completeCfxLink).not.toHaveBeenCalled();
  });

  it('completes with the cookie and payload, then returns to a fixed account URL', async () => {
    mocks.cookie.value = 'attempt0000001.secret';
    mocks.completeCfxLink.mockResolvedValue({ identity: {}, username: 'ravi_rp' });

    const response = await getCallback(callback('encrypted-payload'));

    expect(mocks.completeCfxLink.mock.calls[0]?.[2]).toEqual({
      cookie: 'attempt0000001.secret',
      payload: 'encrypted-payload',
    });
    expect(response.headers.get('location')).toBe('https://xenon.test/portal/account?cfx=linked');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('set-cookie')).toMatch(/xenon_cfx_link=;.*Max-Age=0/i);
  });

  it('maps a refusal to its reason and never reflects the payload', async () => {
    mocks.completeCfxLink.mockRejectedValue(
      new (CfxLinkError as unknown as new (reason: string) => Error)('conflict'),
    );

    const response = await getCallback(callback('secret-payload-bytes'));

    const location = response.headers.get('location') ?? '';
    expect(location).toBe('https://xenon.test/portal/account?cfx=conflict');
    expect(location).not.toContain('secret-payload-bytes');
  });

  it('hides unexpected failures behind a generic status', async () => {
    mocks.completeCfxLink.mockRejectedValue(new Error('connection string postgres://u:p@h'));
    const response = await getCallback(callback('x'));
    expect(response.headers.get('location')).toBe('https://xenon.test/portal/account?cfx=error');
  });
});

describe('POST /api/v1/me/cfx/unlink', () => {
  it('requires the typed confirmation', async () => {
    const response = await postUnlink(
      form('/api/v1/me/cfx/unlink', 'https://xenon.test', { confirm: 'yes' }),
    );
    expect(response.headers.get('location')).toContain('cfx=unlink-confirm');
    expect(mocks.unlinkCfxAccount).not.toHaveBeenCalled();
  });

  it('unlinks with the confirmation from the same origin only', async () => {
    const crossSite = await postUnlink(
      form('/api/v1/me/cfx/unlink', 'https://evil.test', { confirm: 'UNLINK' }),
    );
    expect(crossSite.headers.get('location')).toContain('cfx=error');
    expect(mocks.unlinkCfxAccount).not.toHaveBeenCalled();

    const response = await postUnlink(
      form('/api/v1/me/cfx/unlink', 'https://xenon.test', { confirm: 'UNLINK' }),
    );
    expect(response.headers.get('location')).toContain('cfx=unlinked');
    expect(mocks.unlinkCfxAccount).toHaveBeenCalledTimes(1);
  });
});
