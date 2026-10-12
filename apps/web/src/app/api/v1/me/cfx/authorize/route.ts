import { NextResponse } from 'next/server';

import { prisma } from '@xenon/database';
import { startCfxLink } from '@xenon/fivem';
import { requireUser } from '@xenon/permissions';

import { assertSameOrigin } from '~/server/api';
import { cfxFormRoute, cfxLinkConfig, requestIp, setBindingCookie } from '~/server/cfx';
import { currentActor } from '~/server/context';

/**
 * POST /api/v1/me/cfx/authorize
 *
 * Start "Connect Cfx.re". Submitted as a plain same-origin form so it works
 * without JavaScript; answers 303 to forum.cfx.re's User API key consent page
 * and sets the httpOnly cookie that binds the eventual callback to this
 * browser and this Xenon session.
 */
export async function POST(request: Request): Promise<NextResponse> {
  return cfxFormRoute(async () => {
    assertSameOrigin(request);
    const actor = await currentActor();
    requireUser(actor);

    const started = await startCfxLink(prisma, actor, cfxLinkConfig(), {
      ip: requestIp(request),
    });

    const response = NextResponse.redirect(started.authorizeUrl, 303);
    response.headers.set('Cache-Control', 'no-store');
    setBindingCookie(response, started.cookie, started.expiresAt);
    return response;
  });
}
