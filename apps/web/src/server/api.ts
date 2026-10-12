import { NextResponse } from 'next/server';

import { publicEnv } from '@xenon/config/public';
import {
  ForbiddenError,
  isDomainError,
  RateLimitError,
  toSafeMessage,
  ValidationError,
} from '@xenon/core';
import { consumeRateLimit, type RateLimitRule } from '@xenon/jobs';

/**
 * Plumbing for the session-authenticated website API (`/api/v1/*`).
 *
 * Responses are JSON and never cached: every body is either personal or a
 * live reading. Domain errors map to the status table in docs/ARCHITECTURE.md
 * and carry only their `safeMessage`; anything unexpected becomes a generic
 * 500 so a stack trace or connection string never reaches a browser.
 */

const NO_STORE = 'no-store';

export function apiJson(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': NO_STORE, ...headers },
  });
}

/** Translate a thrown value into a safe JSON error response. */
export function apiError(error: unknown): NextResponse {
  if (error instanceof ValidationError) {
    return apiJson(
      { ok: false, code: error.code, error: error.safeMessage, fieldErrors: error.fieldErrors },
      error.httpStatus,
    );
  }

  if (error instanceof RateLimitError) {
    return apiJson({ ok: false, code: error.code, error: error.safeMessage }, error.httpStatus, {
      'Retry-After': String(Math.max(1, Math.ceil(error.retryAfterSeconds))),
    });
  }

  if (isDomainError(error)) {
    return apiJson({ ok: false, code: error.code, error: error.safeMessage }, error.httpStatus);
  }

  console.error('[api] unhandled error', error);
  return apiJson({ ok: false, code: 'INTERNAL', error: toSafeMessage(error) }, 500);
}

/** Run a handler body, translating anything it throws. */
export async function runApi(body: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await body();
  } catch (error) {
    return apiError(error);
  }
}

/**
 * Refuse a state-changing request that did not come from the site itself.
 *
 * Session cookies are sent cross-site on top-level navigations and by older
 * browsers, so a mutation must prove it was issued by this origin. A missing
 * `Origin` is refused too: every browser sends it on a cross-origin or
 * non-GET fetch, so its absence means a non-browser client replaying a cookie.
 */
export function assertSameOrigin(
  request: Request,
  siteUrl: string = publicEnv.NEXT_PUBLIC_SITE_URL,
): void {
  const origin = request.headers.get('origin');
  if (origin === null || origin !== new URL(siteUrl).origin) {
    throw new ForbiddenError('same-origin request');
  }
}

/** Budget for website API mutations, per account. */
const API_MUTATION_LIMIT: RateLimitRule = { name: 'api:v1:mutation', limit: 30, windowSeconds: 60 };

/** Consume one unit of the caller's mutation budget; throws `RateLimitError` when spent. */
export async function enforceApiMutationLimit(identity: string): Promise<void> {
  const result = await consumeRateLimit(API_MUTATION_LIMIT, identity);
  if (!result.allowed) throw new RateLimitError(result.retryAfterSeconds);
}

/** Read a JSON body. A malformed body is a validation failure, not a 500. */
export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    throw new ValidationError({ _form: ['Request body must be JSON'] });
  }
}
