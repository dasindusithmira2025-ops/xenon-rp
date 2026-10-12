import { NextResponse } from 'next/server';

import { bridgeEventInput } from '@xenon/contracts';
import { isDomainError, toSafeMessage } from '@xenon/core';
import { prisma } from '@xenon/database';
import { recordBridgeEvent } from '@xenon/fivem';

import { verifyBridgeRequest } from '~/server/bridge';

/**
 * POST /api/bridge/events
 *
 * Gameplay events the FiveM bridge forwards: player connected/disconnected,
 * txAdmin scheduled restarts and txAdmin bans. Each becomes an integration
 * event in the outbox (keyed on the bridge's `eventId`, so a retried POST is
 * recorded once); a txAdmin ban also becomes a FiveM-scope moderation case.
 * Nothing here changes a Xenon account's status.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const verified = await verifyBridgeRequest<unknown>(request, 'events');
  if (!verified.ok) return verified.response;

  const parsed = bridgeEventInput.safeParse(verified.body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'Malformed body' }, { status: 422 });
  }

  try {
    await recordBridgeEvent(prisma, parsed.data);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (!isDomainError(error)) console.error('[bridge] event ingestion failed', error);
    return NextResponse.json(
      { ok: false, error: toSafeMessage(error) },
      { status: isDomainError(error) ? error.httpStatus : 500 },
    );
  }
}
