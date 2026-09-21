import { NextResponse } from 'next/server';
import { z } from 'zod';

import { prisma } from '@xenon/database';
import { recordStatusSnapshot } from '@xenon/domain';

import { verifyBridgeRequest } from '~/server/bridge';

/**
 * POST /api/bridge/presence
 *
 * The game server pushing its own status.
 *
 * Xenon also polls, and polling is the primary mechanism because it works when
 * the server has crashed - a server that has stopped cannot tell you it has
 * stopped. This endpoint exists for the opposite case: a server behind NAT or
 * a firewall that Xenon cannot reach, which can still reach out.
 */
const presenceInput = z.object({
  slug: z.string().min(1).max(64),
  players: z.number().int().min(0).max(4096),
  maxPlayers: z.number().int().min(1).max(4096).optional(),
  queue: z.number().int().min(0).max(4096).optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const verified = await verifyBridgeRequest<unknown>(request);
  if (!verified.ok) return verified.response;

  const parsed = presenceInput.safeParse(verified.body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'Malformed body' }, { status: 422 });
  }

  const server = await prisma.server.findUnique({ where: { slug: parsed.data.slug } });
  if (server === null) {
    return NextResponse.json(
      { ok: false, error: `No server called ${parsed.data.slug} is configured` },
      { status: 404 },
    );
  }

  await recordStatusSnapshot(prisma, {
    serverId: server.id,
    online: true,
    playerCount: parsed.data.players,
    maxPlayers: parsed.data.maxPlayers ?? server.maxPlayers,
    queueLength: parsed.data.queue ?? null,
  });

  return NextResponse.json({ ok: true });
}
