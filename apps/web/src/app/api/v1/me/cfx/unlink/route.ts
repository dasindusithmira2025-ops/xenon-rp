import { type NextResponse } from 'next/server';

import { prisma } from '@xenon/database';
import { unlinkCfxAccount } from '@xenon/fivem';

import { assertSameOrigin } from '~/server/api';
import { backToAccount, cfxFormRoute, UNLINK_PHRASE } from '~/server/cfx';
import { currentActor } from '~/server/context';

/**
 * POST /api/v1/me/cfx/unlink
 *
 * Remove the verified Cfx.re link. Same-origin form with a typed confirmation
 * (`confirm=UNLINK`); rate limited and audited. Relinking requires a fresh
 * Cfx.re authorization.
 */
export async function POST(request: Request): Promise<NextResponse> {
  return cfxFormRoute(async () => {
    assertSameOrigin(request);
    const form = await request.formData().catch(() => null);
    if (form?.get('confirm') !== UNLINK_PHRASE) return backToAccount('unlink-confirm');
    await unlinkCfxAccount(prisma, await currentActor());
    return backToAccount('unlinked');
  });
}
