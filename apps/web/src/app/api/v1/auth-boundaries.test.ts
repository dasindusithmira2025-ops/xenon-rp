import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PermissionKey } from '@xenon/core';
import type { Actor } from '@xenon/permissions';

import { POST as postDecision } from './applications/[reference]/decision/route';
import { GET as getDiagnostics } from './integrations/diagnostics/route';
import { GET as getMe } from './me/route';
import { GET as getWhitelist } from './me/whitelist/route';

/**
 * Authentication and authorization boundaries of the website API.
 *
 * The session, the rate limiter and the domain services are replaced, so these
 * tests assert only what the route layer itself decides: who is turned away,
 * with which status, before any service runs.
 */

const mocks = vi.hoisted(() => ({
  currentActor: vi.fn<() => Promise<Actor>>(),
  approveApplication: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@xenon/config/public', () => ({
  publicEnv: { NEXT_PUBLIC_SITE_URL: 'https://xenon.test' },
}));
vi.mock('~/server/context', () => ({ currentActor: mocks.currentActor }));
vi.mock('@xenon/jobs', () => ({
  consumeRateLimit: () => Promise.resolve({ allowed: true, remaining: 1, retryAfterSeconds: 0 }),
}));
vi.mock('@xenon/applications', () => ({
  approveApplication: mocks.approveApplication,
  rejectApplication: vi.fn(),
  requestChanges: vi.fn(),
  requestInterview: vi.fn(),
  statusLabels: {},
}));

function actor(userId: string | null, permissions: PermissionKey[] = []): Actor {
  return {
    userId,
    publicId: userId === null ? null : 'XN-10001',
    label: 'fixture',
    source: 'WEB',
    permissions: new Set(permissions),
    roleKeys: new Set(),
  };
}

function post(path: string, origin: string | null, body: unknown = {}): Request {
  return new Request(`https://xenon.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin === null ? {} : { origin }) },
    body: JSON.stringify(body),
  });
}

const decisionContext = { params: Promise.resolve({ reference: 'XN-WL-1001' }) };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('signed-out callers', () => {
  beforeEach(() => {
    mocks.currentActor.mockResolvedValue(actor(null));
  });

  it.each([
    ['GET /api/v1/me', () => getMe()],
    ['GET /api/v1/me/whitelist', () => getWhitelist()],
    ['GET /api/v1/integrations/diagnostics', () => getDiagnostics()],
    [
      'POST /api/v1/applications/:reference/decision',
      () =>
        postDecision(
          post('/api/v1/applications/XN-WL-1001/decision', 'https://xenon.test', {
            action: 'approve',
          }),
          decisionContext,
        ),
    ],
  ])('%s → 401, uncached', async (_label, call) => {
    const response = await call();
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('never reaches a service', async () => {
    await postDecision(
      post('/api/v1/applications/XN-WL-1001/decision', 'https://xenon.test', {
        action: 'approve',
      }),
      decisionContext,
    );
    expect(mocks.approveApplication).not.toHaveBeenCalled();
  });
});

describe('cross-origin mutations', () => {
  beforeEach(() => {
    mocks.currentActor.mockResolvedValue(actor('user-1', ['applications.approve']));
  });

  it.each([null, 'https://evil.example'])('refuse Origin %o with 403', async (origin) => {
    const response = await postDecision(
      post('/api/v1/applications/XN-WL-1001/decision', origin, { action: 'approve' }),
      decisionContext,
    );

    expect(response.status).toBe(403);
    expect(mocks.approveApplication).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/applications/:reference/decision', () => {
  beforeEach(() => {
    mocks.currentActor.mockResolvedValue(actor('user-1', ['applications.reject']));
  });

  it.each([
    { action: 'delete' },
    { action: 'reject' },
    { action: 'changes', publicNote: '   ' },
    { action: 'approve', publicNote: 'x'.repeat(2001) },
  ])('rejects the body %o with 422', async (body) => {
    const response = await postDecision(
      post('/api/v1/applications/XN-WL-1001/decision', 'https://xenon.test', body),
      decisionContext,
    );
    expect(response.status).toBe(422);
  });

  it('passes the session actor and WEB-sourced input to the service', async () => {
    mocks.approveApplication.mockResolvedValue({ publicId: 'XN-WL-1001', status: 'APPROVED' });
    const signedIn = actor('user-1', ['applications.approve']);
    mocks.currentActor.mockResolvedValue(signedIn);

    const response = await postDecision(
      post('/api/v1/applications/XN-WL-1001/decision', 'https://xenon.test', {
        action: 'approve',
        publicNote: 'Welcome',
      }),
      decisionContext,
    );

    expect(response.status).toBe(200);
    expect(mocks.approveApplication).toHaveBeenCalledWith(expect.anything(), signedIn, {
      reference: 'XN-WL-1001',
      staffNote: null,
      publicNote: 'Welcome',
    });
  });
});

describe('GET /api/v1/integrations/diagnostics', () => {
  it('refuses a signed-in account without system.manage or discord.manage', async () => {
    mocks.currentActor.mockResolvedValue(actor('user-1', ['applications.approve']));
    expect((await getDiagnostics()).status).toBe(403);
  });
});
