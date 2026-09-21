import { serverEnv } from '@xenon/config/server';
import { IntegrationError, nextRestartAt, NotFoundError } from '@xenon/core';
import type { Db, Server } from '@xenon/database';
import { recordStatusSnapshot, recordWhitelistSync } from '@xenon/domain';

import { type GameIdentifier, type GameServerAdapter, MockGameServerAdapter } from './adapter';
import { HttpGameServerAdapter } from './http-adapter';

// Re-exported so the game-server surface stays in one import for its callers.
export { nextRestartAt };

/**
 * Wiring between the domain and the game servers.
 *
 * Two jobs live here: push one player's whitelist state, and take a status
 * reading. Both are called by the worker, never inline from a request, because
 * both talk to a machine Xenon does not control.
 */

/**
 * Build the adapter for a configured server.
 *
 * Falls back to the mock when the endpoint or the shared secret is missing, so
 * a development clone exercises the full code path instead of crashing on a
 * null URL. Production cannot reach this branch: `@xenon/config` requires
 * FIVEM_BRIDGE_SECRET when NODE_ENV is production.
 */
export function adapterFor(server: Server): GameServerAdapter {
  const secret = serverEnv.FIVEM_BRIDGE_SECRET;

  if (server.adapter === 'MOCK' || server.endpointUrl === null || !secret) {
    return new MockGameServerAdapter();
  }

  return new HttpGameServerAdapter(server.adapter, server.endpointUrl, secret);
}

/** True when the platform is talking to a real game server rather than the mock. */
export function hasRealAdapter(server: Server): boolean {
  return (
    server.adapter !== 'MOCK' &&
    server.endpointUrl !== null &&
    Boolean(serverEnv.FIVEM_BRIDGE_SECRET)
  );
}

/**
 * Push a user's whitelist state to every configured server.
 *
 * Identifiers come from the database, so a player with no linked identity is a
 * no-op rather than an error: they cannot connect anyway, and the state will be
 * pushed the moment they link.
 *
 * A failure against any server throws, which is what makes the job retry. The
 * canonical whitelist row has already been written by `grantWhitelist`, so a
 * retry storm against an offline FXServer never threatens the decision itself.
 */
export async function syncWhitelistForUser(db: Db, userId: string): Promise<{ pushed: number }> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      publicId: true,
      whitelistState: true,
      whitelist: { select: { reason: true } },
      gameIdentities: {
        where: { unlinkedAt: null },
        select: { kind: true, value: true },
      },
    },
  });
  if (user === null) throw new NotFoundError('User', userId);

  const identifiers: GameIdentifier[] = user.gameIdentities.map((identity) => ({
    kind: identity.kind,
    value: identity.value,
  }));

  if (identifiers.length === 0) {
    await recordWhitelistSync(db, userId, { ok: true });
    return { pushed: 0 };
  }

  const servers = await db.server.findMany();
  const allowed = user.whitelistState === 'APPROVED';

  let pushed = 0;
  let failure: Error | undefined;

  for (const server of servers) {
    try {
      await adapterFor(server).pushWhitelist({
        identifiers,
        allowed,
        reason: user.whitelist?.reason ?? null,
        publicId: user.publicId,
      });
      pushed += 1;
    } catch (error) {
      // Keep going: one unreachable server must not stop the others from being
      // brought up to date.
      failure ??= error instanceof Error ? error : new IntegrationError('fivem', String(error));
    }
  }

  if (failure !== undefined) {
    await recordWhitelistSync(db, userId, { ok: false, error: failure.message });
    throw failure;
  }

  await recordWhitelistSync(db, userId, { ok: true });
  return { pushed };
}

/** Probe one server and store the reading. Never throws. */
export async function pollServerStatus(db: Db, serverId: string): Promise<void> {
  const server = await db.server.findUnique({ where: { id: serverId } });
  if (server === null) throw new NotFoundError('Server', serverId);

  const reading = await adapterFor(server).status();

  await recordStatusSnapshot(db, {
    serverId: server.id,
    online: reading.online,
    playerCount: reading.playerCount,
    maxPlayers: reading.maxPlayers ?? server.maxPlayers,
    queueLength: reading.queueLength,
    latencyMs: reading.latencyMs,
    nextRestartAt: nextRestartAt(server.restartCron),
    error: reading.error,
  });
}

/** Whitelist state for a set of identifiers, for the bridge's connect check. */
export async function whitelistStateForIdentifiers(
  db: Db,
  identifiers: readonly GameIdentifier[],
): Promise<{ allowed: boolean; publicId: string | null; reason: string | null }> {
  if (identifiers.length === 0) return { allowed: false, publicId: null, reason: 'No identifiers' };

  const identity = await db.gameIdentity.findFirst({
    where: {
      unlinkedAt: null,
      OR: identifiers.map((identifier) => ({
        kind: identifier.kind,
        value: identifier.value,
      })),
    },
    select: {
      user: {
        select: {
          publicId: true,
          status: true,
          whitelistState: true,
          whitelist: { select: { reason: true } },
        },
      },
    },
  });

  if (identity === null) {
    return { allowed: false, publicId: null, reason: 'Account not linked' };
  }

  const { user } = identity;
  if (user.status !== 'ACTIVE') {
    return { allowed: false, publicId: user.publicId, reason: 'Account suspended' };
  }

  return {
    allowed: user.whitelistState === 'APPROVED',
    publicId: user.publicId,
    reason:
      user.whitelistState === 'APPROVED' ? null : (user.whitelist?.reason ?? 'Not whitelisted'),
  };
}

/** Record that an identifier was seen in game. Cheap presence tracking. */
export async function touchIdentity(db: Db, identifiers: readonly GameIdentifier[]): Promise<void> {
  if (identifiers.length === 0) return;

  await db.gameIdentity.updateMany({
    where: {
      unlinkedAt: null,
      OR: identifiers.map((identifier) => ({ kind: identifier.kind, value: identifier.value })),
    },
    data: { lastSeenAt: new Date() },
  });
}
