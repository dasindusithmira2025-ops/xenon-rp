import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { serverEnv } from '@xenon/config/server';
import { prisma } from '@xenon/database';
import { CfxLinkError, completeCfxLink } from '@xenon/fivem';

import {
  backToAccount,
  CFX_COOKIE,
  cfxForum,
  cfxLinkConfig,
  clearBindingCookie,
} from '~/server/cfx';
import { currentActor } from '~/server/context';

/**
 * GET /api/v1/me/cfx/callback?payload=…
 *
 * forum.cfx.re redirects here after the player approves. The payload is
 * encrypted to this attempt's one-time key; completion verifies the binding
 * cookie, the session owner, single use, expiry and the nonce before asking
 * the forum who the key belongs to, then revokes the key.
 *
 * Every outcome redirects to a fixed account-page URL with a status key. The
 * payload is never logged or echoed, and the response asks the browser not to
 * send this URL onward as a referrer.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const actor = await currentActor();
  if (actor.userId === null) {
    // Sign in first; the attempt stays bound to the account that started it.
    const signIn = new URL('/signin', serverEnv.NEXT_PUBLIC_SITE_URL);
    signIn.searchParams.set('callbackUrl', '/portal/account');
    const response = NextResponse.redirect(signIn, 303);
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
  }

  const payload = new URL(request.url).searchParams.get('payload');
  const store = await cookies();

  let result: string;
  try {
    await completeCfxLink(
      prisma,
      actor,
      { cookie: store.get(CFX_COOKIE)?.value, payload },
      cfxLinkConfig(),
      cfxForum(),
    );
    result = 'linked';
  } catch (error) {
    if (error instanceof CfxLinkError) {
      result = error.reason;
    } else {
      console.error('[cfx] link callback failed', error instanceof Error ? error.name : 'unknown');
      result = 'error';
    }
  }

  const response = backToAccount(result);
  clearBindingCookie(response);
  return response;
}
