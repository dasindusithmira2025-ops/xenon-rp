import { type BridgeEventInput, isTrustedIdentityKind } from '@xenon/contracts';
import { NotFoundError } from '@xenon/core';
import { type Db, transaction } from '@xenon/database';
import { eventDiscordId, hashIp } from '@xenon/domain';
import { emitIntegrationEvent } from '@xenon/jobs';

import { formatIdentifier, type GameIdentifier } from './adapter';
import { touchIdentity } from './sync';

/**
 * Ingestion of events reported by the FiveM bridge (`POST /api/bridge/events`).
 *
 * The bridge is authenticated (HMAC + nonce) before this runs, but the
 * identifiers it relays are still treated with suspicion: only the kinds
 * FXServer verifies itself resolve to a Xenon account, and identifiers that
 * resolve to more than one account resolve to none.
 *
 * Every event is keyed on the bridge-generated `eventId`, so a retried POST
 * records exactly one integration event.
 */

interface ResolvedPlayer {
  readonly userId: string;
  readonly publicId: string;
  readonly discordId: string | null;
}

async function resolvePlayer(
  db: Db,
  trusted: readonly GameIdentifier[],
): Promise<ResolvedPlayer | null> {
  if (trusted.length === 0) return null;

  const matches = await db.gameIdentity.findMany({
    where: {
      unlinkedAt: null,
      OR: trusted.map((identifier) => ({ kind: identifier.kind, value: identifier.value })),
    },
    select: {
      userId: true,
      user: { select: { publicId: true, discordAccount: { select: { discordId: true } } } },
    },
  });

  const [first] = matches;
  if (first === undefined || matches.some((match) => match.userId !== first.userId)) return null;

  return {
    userId: first.userId,
    publicId: first.user.publicId,
    discordId: eventDiscordId(first.user.discordAccount?.discordId),
  };
}

export interface RecordedBridgeEvent {
  /** The FiveM moderation case, for PLAYER_BANNED. */
  readonly caseId: string | null;
}

/**
 * Record one bridge event. Unknown server slug → NotFoundError.
 *
 * A txAdmin ban becomes a FIVEM-scope ModerationCase and a PLAYER_BANNED
 * event. It deliberately does not touch the Xenon account's status: txAdmin
 * already enforces its own ban at connect time, and a game-server ban is not a
 * platform decision.
 */
export async function recordBridgeEvent(
  db: Db,
  input: BridgeEventInput,
): Promise<RecordedBridgeEvent> {
  const server = await db.server.findUnique({
    where: { slug: input.serverSlug },
    select: { slug: true },
  });
  if (server === null) throw new NotFoundError('Server', input.serverSlug);

  const idempotencyKey = `bridge:${input.eventId}`;

  switch (input.type) {
    case 'PLAYER_CONNECTED':
    case 'PLAYER_DISCONNECTED': {
      const trusted = input.identifiers.filter((identifier) =>
        isTrustedIdentityKind(identifier.kind),
      );
      const player = await resolvePlayer(db, trusted);

      if (input.type === 'PLAYER_CONNECTED') {
        await touchIdentity(db, trusted);
        await emitIntegrationEvent(db, {
          type: 'PLAYER_CONNECTED',
          payload: {
            serverSlug: server.slug,
            playerPublicId: player?.publicId ?? null,
            playerName: input.playerName,
          },
          idempotencyKey,
          source: 'FIVEM',
        });
      } else {
        await emitIntegrationEvent(db, {
          type: 'PLAYER_DISCONNECTED',
          payload: {
            serverSlug: server.slug,
            playerPublicId: player?.publicId ?? null,
            playerName: input.playerName,
            reason: input.reason,
          },
          idempotencyKey,
          source: 'FIVEM',
        });
      }
      return { caseId: null };
    }

    case 'SERVER_RESTART_SCHEDULED': {
      await emitIntegrationEvent(db, {
        type: 'SERVER_RESTART_SCHEDULED',
        payload: {
          serverSlug: server.slug,
          restartAt: new Date(Date.now() + input.secondsRemaining * 1000).toISOString(),
          secondsRemaining: input.secondsRemaining,
          origin: 'TXADMIN',
        },
        idempotencyKey,
        source: 'FIVEM',
      });
      return { caseId: null };
    }

    case 'PLAYER_BANNED': {
      const trusted = input.identifiers.filter((identifier) =>
        isTrustedIdentityKind(identifier.kind),
      );
      const player = await resolvePlayer(db, trusted);
      const [firstTrusted] = trusted;
      const reason = input.reason.length > 0 ? input.reason : 'No reason given';
      const expiresAt =
        input.durationSeconds === null ? null : new Date(Date.now() + input.durationSeconds * 1000);
      // txAdmin's action id when it supplied one; otherwise the bridge event id,
      // so a retried delivery still lands on the same case.
      const externalRef = input.externalRef ?? idempotencyKey;

      return transaction(db, async (tx) => {
        const created = await tx.moderationCase.createMany({
          data: [
            {
              userId: player?.userId ?? null,
              // Never the raw identifier: only a peppered hash, for correlation.
              identifierHash:
                player === null && firstTrusted !== undefined
                  ? hashIp(formatIdentifier(firstTrusted))
                  : null,
              scope: 'FIVEM',
              kind: 'BAN',
              source: 'FIVEM',
              reason,
              externalRef,
              actorLabel: 'txAdmin',
              expiresAt,
            },
          ],
          skipDuplicates: true,
        });

        const moderationCase = await tx.moderationCase.findUniqueOrThrow({
          where: { source_externalRef: { source: 'FIVEM', externalRef } },
          select: { id: true },
        });

        // A second delivery of the same txAdmin action (even under a new event
        // id) must not announce the ban twice.
        if (created.count > 0) {
          await emitIntegrationEvent(tx, {
            type: 'PLAYER_BANNED',
            payload: {
              playerPublicId: player?.publicId ?? null,
              discordId: player?.discordId ?? null,
              scope: 'FIVEM',
              reason,
              expiresAt: expiresAt?.toISOString() ?? null,
              caseId: moderationCase.id,
            },
            idempotencyKey,
            source: 'FIVEM',
          });
        }

        return { caseId: moderationCase.id };
      });
    }
  }
}
