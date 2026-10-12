import 'server-only';

import { NextResponse } from 'next/server';

import { serverEnv } from '@xenon/config/server';
import { isDomainError, RateLimitError } from '@xenon/core';
import { CfxLinkError, type CfxForum, type CfxLinkConfig, httpCfxForum } from '@xenon/fivem';

/**
 * Wiring for the website "Connect Cfx.re" routes (`/api/v1/me/cfx/*`).
 *
 * The callback URL is fixed and derived from the configured public origin, so
 * there is no caller-controlled redirect anywhere in the flow. The binding
 * cookie is httpOnly, scoped to the Cfx routes, SameSite=Lax (it must survive
 * the top-level redirect back from forum.cfx.re) and lives exactly as long as
 * the attempt.
 */

export const CFX_COOKIE = 'xenon_cfx_link';
const COOKIE_PATH = '/api/v1/me/cfx';
const ACCOUNT_PAGE = '/portal/account';

/** The site is not on https, so forum.cfx.re would refuse to return here. */
class InsecureCallbackError extends Error {}

export function cfxLinkConfig(): CfxLinkConfig {
  const forumUrl = serverEnv.CFX_FORUM_URL;
  if (serverEnv.NODE_ENV === 'production' && !forumUrl.startsWith('https://')) {
    throw new Error('CFX_FORUM_URL must be https in production');
  }
  const callbackUrl = new URL(`${COOKIE_PATH}/callback`, serverEnv.NEXT_PUBLIC_SITE_URL);
  // forum.cfx.re refuses non-https auth_redirect targets (checked against the
  // live forum), so an http origin would strand the player on its error page.
  if (callbackUrl.protocol !== 'https:' && new URL(forumUrl).host === 'forum.cfx.re') {
    throw new InsecureCallbackError('Cfx.re linking needs an https site URL');
  }
  return {
    forumUrl,
    callbackUrl: callbackUrl.toString(),
    applicationName: serverEnv.CFX_APP_NAME,
    serverSecret: serverEnv.AUTH_SECRET,
  };
}

export function cfxForum(): CfxForum {
  return httpCfxForum({
    baseUrl: serverEnv.CFX_FORUM_URL,
    userAgent: `${serverEnv.CFX_APP_NAME} account linking (+${serverEnv.NEXT_PUBLIC_SITE_URL})`,
  });
}

/** A same-site redirect back to the account page with a fixed status key. */
export function backToAccount(result: string): NextResponse {
  const url = new URL(ACCOUNT_PAGE, serverEnv.NEXT_PUBLIC_SITE_URL);
  url.searchParams.set('cfx', result);
  const response = NextResponse.redirect(url, 303);
  // The callback URL carried an encrypted payload; never let it leak onward.
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export function setBindingCookie(response: NextResponse, value: string, expiresAt: Date): void {
  response.cookies.set(CFX_COOKIE, value, {
    httpOnly: true,
    secure: serverEnv.NODE_ENV === 'production',
    sameSite: 'lax',
    path: COOKIE_PATH,
    expires: expiresAt,
  });
}

export function clearBindingCookie(response: NextResponse): void {
  response.cookies.set(CFX_COOKIE, '', {
    httpOnly: true,
    secure: serverEnv.NODE_ENV === 'production',
    sameSite: 'lax',
    path: COOKIE_PATH,
    maxAge: 0,
  });
}

/** The client address for audit hashing; spoofable values only cost the spoofer. */
export function requestIp(request: Request): string | null {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip')
  );
}

/** Typed confirmation for unlinking; a deliberate, audited step. */
export const UNLINK_PHRASE = 'UNLINK';

/**
 * Status keys the account page understands after any Cfx route. Fixed values
 * only: nothing from the request is ever reflected into the redirect.
 */
export type CfxStatus =
  | 'linked'
  | 'unlinked'
  | 'cancelled'
  | 'expired'
  | 'invalid'
  | 'mismatch'
  | 'conflict'
  | 'already-linked'
  | 'provider'
  | 'insecure-callback'
  | 'rate-limited'
  | 'unlink-confirm'
  | 'not-linked'
  | 'signin'
  | 'error';

/**
 * Run a form-posted Cfx route. These are submitted by plain HTML forms, so
 * every failure comes back as a redirect to the account page with a status
 * key rather than a JSON body the player would see as raw text.
 */
export async function cfxFormRoute(body: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof CfxLinkError) return backToAccount(error.reason);
    if (error instanceof InsecureCallbackError) return backToAccount('insecure-callback');
    if (error instanceof RateLimitError) return backToAccount('rate-limited');
    if (isDomainError(error) && error.code === 'UNAUTHENTICATED') return backToAccount('signin');
    if (isDomainError(error) && error.code === 'CONFLICT') return backToAccount('not-linked');
    if (!isDomainError(error)) {
      console.error('[cfx] route failed', error instanceof Error ? error.name : 'unknown');
    }
    return backToAccount('error');
  }
}
