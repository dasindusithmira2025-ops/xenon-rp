import { describe, expect, it, vi } from 'vitest';

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  UnauthenticatedError,
  ValidationError,
} from '@xenon/core';

import { apiError, assertSameOrigin, readJsonBody } from './api';

vi.mock('@xenon/config/public', () => ({
  publicEnv: { NEXT_PUBLIC_SITE_URL: 'https://xenon.test/' },
}));

function post(headers: Record<string, string>, body = '{}'): Request {
  return new Request('https://xenon.test/api/v1/me/link-code', { method: 'POST', headers, body });
}

describe('assertSameOrigin', () => {
  it('accepts the site origin', () => {
    expect(() => {
      assertSameOrigin(post({ origin: 'https://xenon.test' }));
    }).not.toThrow();
  });

  it.each([
    ['missing', {}],
    ['another site', { origin: 'https://evil.example' }],
    ['another scheme', { origin: 'http://xenon.test' }],
    ['another port', { origin: 'https://xenon.test:8443' }],
    ['a lookalike subdomain', { origin: 'https://xenon.test.evil.example' }],
    ['the literal null origin', { origin: 'null' }],
  ])('refuses an Origin that is %s', (_label, headers) => {
    expect(() => {
      assertSameOrigin(post(headers));
    }).toThrow(ForbiddenError);
  });

  it('compares against the configured site URL, not the request URL', () => {
    expect(() => {
      assertSameOrigin(post({ origin: 'https://xenon.test' }), 'https://play.xenon.test');
    }).toThrow(ForbiddenError);
  });
});

describe('apiError', () => {
  it.each([
    [new UnauthenticatedError(), 401],
    [new ForbiddenError('x'), 403],
    [new NotFoundError('Thing'), 404],
    [new ConflictError('internal detail', 'Safe text'), 409],
    [new ValidationError({ action: ['Required'] }), 422],
    [new RateLimitError(30), 429],
  ])('maps %o to %i with a safe body and no caching', async (error, status) => {
    const response = apiError(error);
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as unknown;
    expect(JSON.stringify(body)).not.toContain('internal detail');
  });

  it('sets Retry-After on a rate limit', () => {
    expect(apiError(new RateLimitError(12.2)).headers.get('retry-after')).toBe('13');
  });

  it('never leaks an unexpected error message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = apiError(new Error('postgres://user:secret@db/xenon'));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('secret');
    spy.mockRestore();
  });
});

describe('readJsonBody', () => {
  it('turns a malformed body into a validation error', async () => {
    await expect(readJsonBody(post({}, '{nope'))).rejects.toBeInstanceOf(ValidationError);
  });
});
