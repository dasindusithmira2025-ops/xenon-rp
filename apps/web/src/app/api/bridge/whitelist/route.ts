import { NextResponse } from 'next/server';

import { fivemEnv } from '@xenon/config/fivem';
import { isTrustedIdentityKind } from '@xenon/contracts';
import { prisma } from '@xenon/database';
import { touchIdentity, whitelistStateForIdentifiers } from '@xenon/fivem';
import { bridgeWhitelistCheckInput } from '@xenon/validation';

import { verifyBridgeRequest } from '~/server/bridge';

/**
 * POST /api/bridge/whitelist
 *
 * The connect gate. Called from the game server's `playerConnecting` deferral,
 * so it has to answer quickly and it has to answer honestly: a failure here
 * must not silently admit somebody, and must not lock everybody out either.
 * The bridge decides which way to fail; this endpoint only reports the truth.
 *
 * The reason is deliberately plain English - it is shown to the player on the
 * connection screen, where "NOT_WHITELISTED" helps nobody.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const verified = await verifyBridgeRequest<unknown>(request, 'whitelist');
  if (!verified.ok) return verified.response;

  const parsed = bridgeWhitelistCheckInput.safeParse(verified.body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'Malformed body' }, { status: 422 });
  }

  const state = await whitelistStateForIdentifiers(
    prisma,
    parsed.data.identifiers,
    fivemEnv.FIVEM_ADMISSION_MODE,
  );

  // Presence is recorded regardless of the outcome: knowing somebody tried to
  // connect is useful to staff even when they were refused. Only verified
  // identifiers count, so a spoofed Steam or Discord id cannot move somebody
  // else's last-seen time.
  await touchIdentity(
    prisma,
    parsed.data.identifiers.filter((identifier) => isTrustedIdentityKind(identifier.kind)),
  );

  return NextResponse.json({
    ok: true,
    allowed: state.allowed,
    publicId: state.publicId,
    reason: state.reason,
  });
}
