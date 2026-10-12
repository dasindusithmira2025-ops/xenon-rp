import { type NextResponse } from 'next/server';

import { prisma } from '@xenon/database';
import { cancelCfxLink } from '@xenon/fivem';

import { assertSameOrigin } from '~/server/api';
import { backToAccount, cfxFormRoute, clearBindingCookie } from '~/server/cfx';
import { currentActor } from '~/server/context';

/** POST /api/v1/me/cfx/cancel - abandon an outstanding "Connect Cfx.re" attempt. */
export async function POST(request: Request): Promise<NextResponse> {
  return cfxFormRoute(async () => {
    assertSameOrigin(request);
    await cancelCfxLink(prisma, await currentActor());
    const response = backToAccount('cancelled');
    clearBindingCookie(response);
    return response;
  });
}
