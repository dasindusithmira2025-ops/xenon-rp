import { NextResponse } from 'next/server';

import { toSafeMessage } from '@xenon/core';
import { prisma } from '@xenon/database';
import { redeemLinkCode } from '@xenon/fivem';
import { bridgeLinkInput } from '@xenon/validation';

import { verifyBridgeRequest } from '~/server/bridge';

/**
 * POST /api/bridge/link
 *
 * A player typed `/link XEN-7K4P9` in game. The bridge relays it with the
 * identifiers FXServer reports for that connection, which is the only way to
 * prove the person holding the Xenon session is the person at that client - a
 * self-declared identifier would let anybody claim anybody's licence.
 *
 * The code is single use, expires in ten minutes, and only its SHA-256 is
 * stored, so a database leak cannot be replayed into an account takeover.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const verified = await verifyBridgeRequest<unknown>(request);
  if (!verified.ok) return verified.response;

  const parsed = bridgeLinkInput.safeParse(verified.body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'That code is not valid. Generate a new one from your Xenon portal.' },
      { status: 422 },
    );
  }

  try {
    const result = await redeemLinkCode(prisma, {
      code: parsed.data.code,
      identifiers: parsed.data.identifiers,
      playerName: parsed.data.playerName,
    });

    return NextResponse.json({
      ok: true,
      publicId: result.publicId,
      displayName: result.displayName,
      whitelisted: result.whitelisted,
      identifiers: result.identities.length,
    });
  } catch (error) {
    // Every rejection reason collapses to one message: distinguishing expired
    // from wrong would let somebody probe for valid codes.
    return NextResponse.json({ ok: false, error: toSafeMessage(error) }, { status: 409 });
  }
}
