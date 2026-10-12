import { fivemEnv } from '@xenon/config/fivem';
import { IntegrationError, nextRestartAt, NotFoundError } from '@xenon/core';
import { type Db, type Server, transaction } from '@xenon/database';
import { recordStatusSnapshot, recordWhitelistSync } from '@xenon/domain';
import { emitIntegrationEvent } from '@xenon/jobs';

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
  const secret = fivemEnv.FIVEM_BRIDGE_SECRET;

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
    Boolean(fivemEnv.FIVEM_BRIDGE_SECRET)
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

/**
 * Probe one server and store the reading. The adapter never throws: an outage
 * is a reading.
 *
 * A change in the online flag (or the very first reading) is announced as a
 * SERVER_STATUS_CHANGED event, written in the same transaction as the snapshot
 * so an announced change always has the reading behind it.
 */
export async function pollServerStatus(db: Db, serverId: string): Promise<void> {
  const server = await db.server.findUnique({ where: { id: serverId } });
  if (server === null) throw new NotFoundError('Server', serverId);

  const reading = await adapterFor(server).status();
  const maxPlayers = reading.maxPlayers ?? server.maxPlayers;

  await transaction(db, async (tx) => {
    const previous = await tx.serverStatusSnapshot.findFirst({
      where: { serverId: server.id },
      orderBy: { createdAt: 'desc' },
      select: { online: true },
    });

    const snapshot = await recordStatusSnapshot(tx, {
      serverId: server.id,
      online: reading.online,
      playerCount: reading.playerCount,
      maxPlayers,
      queueLength: reading.queueLength,
      latencyMs: reading.latencyMs,
      nextRestartAt: nextRestartAt(server.restartCron),
      error: reading.error,
    });

    if (previous !== null && previous.online === reading.online) return;

    await emitIntegrationEvent(tx, {
      type: 'SERVER_STATUS_CHANGED',
      payload: {
        serverSlug: server.slug,
        serverName: server.name,
        previousOnline: previous?.online ?? null,
        online: reading.online,
        playerCount: reading.playerCount,
        maxPlayers,
      },
      idempotencyKey: `server_status:${server.id}:${snapshot.id}`,
      source: 'SYSTEM',
    });
  });
}

/** `fivem:` identifiers are the numeric Cfx.re forum account id. */
const FIVEM_ID = /^[1-9]\d{0,11}$/;

export type AdmissionMode = 'cfx-or-legacy' | 'cfx-only';

export const ADMISSION_MESSAGES = {
  noCfx:
    'Sign in to your Cfx.re account in FiveM (Settings → Account), then reconnect. Xenon admits players by their Cfx.re account.',
  notLinked:
    'This Cfx.re account is not linked to Xenon. Connect it on the Xenon website (Account → Connect Cfx.re), then reconnect.',
  conflict: 'Identity conflict — contact staff.',
  suspended: 'Your Xenon account is suspended.',
  notWhitelisted: 'You are not whitelisted yet. Check your application on the Xenon website.',
} as const;

/**
 * The connect decision for the identifiers FXServer reported.
 *
 * The primary key is the `fivem:` identifier - the Cfx.re account id FXServer
 * itself authenticates - matched against the account the player verified on
 * the website. Rockstar licences count only when they were proven earlier
 * (retired in-game code flow) or granted by staff as a documented exception,
 * and in `cfx-only` mode only the staff exception remains. Discord, Steam and
 * other client-reported identifiers never admit anyone. Identifiers that
 * resolve to more than one account refuse the connection outright.
 */
export async function whitelistStateForIdentifiers(
  db: Db,
  identifiers: readonly GameIdentifier[],
  mode: AdmissionMode = 'cfx-or-legacy',
): Promise<{ allowed: boolean; publicId: string | null; reason: string | null }> {
  const cfx = identifiers.find(
    (identifier) => identifier.kind === 'FIVEM' && FIVEM_ID.test(identifier.value),
  );
  const licences = identifiers.filter(
    (identifier) => identifier.kind === 'LICENSE' || identifier.kind === 'LICENSE2',
  );
  const licenceSources: ('FIVEM' | 'STAFF')[] =
    mode === 'cfx-only' ? ['STAFF'] : ['FIVEM', 'STAFF'];

  const candidates = [
    ...(cfx === undefined ? [] : [{ kind: 'FIVEM' as const, value: cfx.value }]),
    ...licences.map((identifier) => ({
      kind: identifier.kind,
      value: identifier.value,
      linkedVia: { in: licenceSources },
    })),
  ];
  if (candidates.length === 0) {
    return { allowed: false, publicId: null, reason: ADMISSION_MESSAGES.noCfx };
  }

  const matches = await db.gameIdentity.findMany({
    where: { unlinkedAt: null, OR: candidates },
    select: {
      userId: true,
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

  const [first] = matches;
  if (first === undefined) {
    return {
      allowed: false,
      publicId: null,
      reason: cfx === undefined ? ADMISSION_MESSAGES.noCfx : ADMISSION_MESSAGES.notLinked,
    };
  }
  if (matches.some((match) => match.userId !== first.userId)) {
    return { allowed: false, publicId: null, reason: ADMISSION_MESSAGES.conflict };
  }

  const { user } = first;
  if (user.status !== 'ACTIVE') {
    return { allowed: false, publicId: user.publicId, reason: ADMISSION_MESSAGES.suspended };
  }
  if (user.whitelistState !== 'APPROVED') {
    return {
      allowed: false,
      publicId: user.publicId,
      reason: user.whitelist?.reason ?? ADMISSION_MESSAGES.notWhitelisted,
    };
  }
  return { allowed: true, publicId: user.publicId, reason: null };
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
