import { NotFoundError } from '@xenon/core';
import type { Db, Server, ServerStatusSnapshot } from '@xenon/database';
import { cacheDelete, cached } from '@xenon/jobs';
import { type Actor, requirePermission } from '@xenon/permissions';

import { recordAudit } from './audit';

/**
 * Server status.
 *
 * A poller writes normalised snapshots; every reader - the homepage badge, the
 * status page, the bot's `/status`, the Discord status board - reads the latest
 * snapshot. No browser ever talks to FXServer, which keeps the game server's
 * address private and means a thousand concurrent visitors produce one probe
 * rather than a thousand.
 *
 * There is no fabricated fallback anywhere in this file. When there is no
 * recent snapshot the state is UNKNOWN and the UI says so, because a made-up
 * player count is worse than an honest "we cannot tell right now".
 */

export type ServerState = 'ONLINE' | 'OFFLINE' | 'DEGRADED' | 'UNKNOWN';

export interface ServerStatusView {
  readonly slug: string;
  readonly name: string;
  readonly state: ServerState;
  readonly playerCount: number | null;
  readonly maxPlayers: number | null;
  readonly queueLength: number | null;
  readonly latencyMs: number | null;
  readonly nextRestartAt: string | null;
  readonly connectUrl: string | null;
  readonly updatedAt: string | null;
  readonly error: string | null;
}

export interface StatusBoard {
  readonly servers: readonly ServerStatusView[];
  readonly aggregate: ServerState;
  readonly totalPlayers: number | null;
  readonly totalCapacity: number | null;
  readonly checkedAt: string | null;
}

const STATUS_CACHE_KEY = 'status:board';
/** Short enough to feel live, long enough that a traffic spike is one query. */
const STATUS_CACHE_TTL = 20;

/** A snapshot older than this tells us nothing useful about right now. */
const STALE_AFTER_MS = 5 * 60 * 1000;

function deriveState(
  snapshot: ServerStatusSnapshot | undefined,
  now: number,
): { state: ServerState; stale: boolean } {
  if (snapshot === undefined) return { state: 'UNKNOWN', stale: true };

  const age = now - snapshot.createdAt.getTime();
  if (age > STALE_AFTER_MS) return { state: 'UNKNOWN', stale: true };
  if (!snapshot.online) return { state: 'OFFLINE', stale: false };

  // Online but the probe could not read a player count: the server answered,
  // the data did not. That is degraded, not healthy.
  if (snapshot.playerCount === null) return { state: 'DEGRADED', stale: false };
  return { state: 'ONLINE', stale: false };
}

/** The public status board, cached. */
export async function statusBoard(db: Db): Promise<StatusBoard> {
  return cached(STATUS_CACHE_KEY, STATUS_CACHE_TTL, async () => {
    const servers = await db.server.findMany({
      where: { isPublic: true },
      orderBy: { sortOrder: 'asc' },
      include: { snapshots: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });

    const now = Date.now();
    const views = servers.map((server): ServerStatusView => {
      const snapshot = server.snapshots[0];
      const { state } = deriveState(snapshot, now);

      return {
        slug: server.slug,
        name: server.name,
        state,
        playerCount: state === 'ONLINE' ? (snapshot?.playerCount ?? null) : null,
        maxPlayers: snapshot?.maxPlayers ?? server.maxPlayers,
        queueLength: state === 'ONLINE' ? (snapshot?.queueLength ?? null) : null,
        latencyMs: snapshot?.latencyMs ?? null,
        nextRestartAt: snapshot?.nextRestartAt?.toISOString() ?? null,
        connectUrl: server.connectUrl,
        updatedAt: snapshot?.createdAt.toISOString() ?? null,
        error: snapshot?.error ?? null,
      };
    });

    const known = views.filter((view) => view.state !== 'UNKNOWN');
    const online = views.filter((view) => view.state === 'ONLINE');

    const aggregate: ServerState =
      views.length === 0 || known.length === 0
        ? 'UNKNOWN'
        : online.length === views.length
          ? 'ONLINE'
          : online.length === 0
            ? 'OFFLINE'
            : 'DEGRADED';

    // Totals are null unless every online server reported a count; a partial
    // sum reads as a real number and is not one.
    const countsKnown = online.every((view) => view.playerCount !== null);

    return {
      servers: views,
      aggregate,
      totalPlayers:
        online.length > 0 && countsKnown
          ? online.reduce((sum, view) => sum + (view.playerCount ?? 0), 0)
          : null,
      totalCapacity: online.every((view) => view.maxPlayers !== null)
        ? online.reduce((sum, view) => sum + (view.maxPlayers ?? 0), 0)
        : null,
      checkedAt:
        views
          .map((view) => view.updatedAt)
          .filter((value): value is string => value !== null)
          .sort()
          .at(-1) ?? null,
    };
  });
}

export interface SnapshotInput {
  readonly serverId: string;
  readonly online: boolean;
  readonly playerCount?: number | null;
  readonly maxPlayers?: number | null;
  readonly queueLength?: number | null;
  readonly latencyMs?: number | null;
  readonly nextRestartAt?: Date | null;
  readonly error?: string | null;
}

/** Write a snapshot and drop the cached board. Called by the poller. */
export async function recordStatusSnapshot(
  db: Db,
  input: SnapshotInput,
): Promise<ServerStatusSnapshot> {
  const snapshot = await db.serverStatusSnapshot.create({
    data: {
      serverId: input.serverId,
      online: input.online,
      playerCount: input.playerCount ?? null,
      maxPlayers: input.maxPlayers ?? null,
      queueLength: input.queueLength ?? null,
      latencyMs: input.latencyMs ?? null,
      nextRestartAt: input.nextRestartAt ?? null,
      error: input.error?.slice(0, 500) ?? null,
    },
  });

  await cacheDelete(STATUS_CACHE_KEY);
  return snapshot;
}

/** Servers the poller should probe. */
export async function pollableServers(db: Db): Promise<readonly Server[]> {
  return db.server.findMany({ orderBy: { sortOrder: 'asc' } });
}

export async function upsertServer(
  db: Db,
  actor: Actor,
  input: {
    slug: string;
    name: string;
    adapter: Server['adapter'];
    connectUrl?: string | undefined;
    endpointUrl?: string | null | undefined;
    maxPlayers?: number | null | undefined;
    restartCron?: string | undefined;
    timezone: string;
    isPublic: boolean;
    sortOrder: number;
  },
  serverId?: string,
): Promise<Server> {
  requirePermission(actor, 'fivem.manage');

  const data = {
    slug: input.slug,
    name: input.name,
    adapter: input.adapter,
    connectUrl: input.connectUrl ?? null,
    endpointUrl: input.endpointUrl ?? null,
    maxPlayers: input.maxPlayers ?? null,
    restartCron: input.restartCron ?? null,
    timezone: input.timezone,
    isPublic: input.isPublic,
    sortOrder: input.sortOrder,
  };

  const server =
    serverId === undefined
      ? await db.server.create({ data })
      : await db.server.update({ where: { id: serverId }, data });

  await recordAudit(db, actor, {
    action: serverId === undefined ? 'server.created' : 'server.updated',
    entityType: 'server',
    entityId: server.id,
    entityLabel: server.slug,
    // The endpoint URL is internal infrastructure detail and stays out of the
    // audit projection.
    after: { name: server.name, adapter: server.adapter, isPublic: server.isPublic },
  });

  await cacheDelete(STATUS_CACHE_KEY);
  return server;
}

export async function deleteServer(db: Db, actor: Actor, serverId: string): Promise<void> {
  requirePermission(actor, 'fivem.manage');

  const server = await db.server.findUnique({ where: { id: serverId } });
  if (server === null) throw new NotFoundError('Server', serverId);

  await db.server.delete({ where: { id: serverId } });
  await recordAudit(db, actor, {
    action: 'server.deleted',
    entityType: 'server',
    entityId: serverId,
    entityLabel: server.slug,
  });
  await cacheDelete(STATUS_CACHE_KEY);
}

/** Trim snapshot history. Called by the maintenance sweep. */
export async function pruneStatusSnapshots(db: Db, olderThanDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const result = await db.serverStatusSnapshot.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return result.count;
}
