import { NotFoundError } from '@xenon/core';
import { transaction, type Db, type Whitelist, type WhitelistState } from '@xenon/database';
import { emitIntegrationEvent, enqueueDurable } from '@xenon/jobs';
import { createNotification, dispatchPending, notificationCopy } from '@xenon/notifications';
import type { Actor } from '@xenon/permissions';

import { recordAudit } from './audit';
import { eventDiscordId } from './integration-events';
import { refreshOnboardingStep } from './users';

/**
 * Whitelist state.
 *
 * `Whitelist` is authoritative and `User.whitelistState` mirrors it for cheap
 * gating reads; both are written in the same statement so they cannot disagree.
 * The game server and Discord learn about the change from outbox jobs and an
 * integration event written in the same transaction, never from an inline
 * call - an FXServer restart must not be able to fail an approval, and a
 * Redis outage must not lose the push.
 */

export interface WhitelistChange {
  readonly userId: string;
  readonly reason?: string | null;
  /** The application that produced the grant, when there was one. */
  readonly sourceSubmissionId?: string | null;
  /** Suppress the player notification when the caller sends its own. */
  readonly silent?: boolean;
}

interface AppliedState {
  readonly whitelist: Whitelist;
  readonly playerPublicId: string;
  readonly discordId: string | null;
}

async function applyState(
  db: Db,
  actor: Actor,
  state: WhitelistState,
  change: WhitelistChange,
  extra: { suspendedUntil?: Date | null } = {},
): Promise<AppliedState> {
  const user = await db.user.findUnique({
    where: { id: change.userId },
    select: {
      publicId: true,
      whitelistState: true,
      discordAccount: { select: { discordId: true } },
    },
  });
  if (user === null) throw new NotFoundError('User', change.userId);

  const now = new Date();
  const granted = state === 'APPROVED';

  const whitelist = await db.whitelist.upsert({
    where: { userId: change.userId },
    create: {
      userId: change.userId,
      state,
      reason: change.reason ?? null,
      grantedAt: granted ? now : null,
      grantedBy: granted ? actor.userId : null,
      revokedAt: state === 'REVOKED' ? now : null,
      revokedBy: state === 'REVOKED' ? actor.userId : null,
      suspendedUntil: extra.suspendedUntil ?? null,
      sourceSubmissionId: change.sourceSubmissionId ?? null,
    },
    update: {
      state,
      reason: change.reason ?? null,
      ...(granted ? { grantedAt: now, grantedBy: actor.userId, revokedAt: null } : {}),
      ...(state === 'REVOKED' ? { revokedAt: now, revokedBy: actor.userId } : {}),
      suspendedUntil: extra.suspendedUntil ?? null,
      ...(change.sourceSubmissionId === undefined
        ? {}
        : { sourceSubmissionId: change.sourceSubmissionId }),
      // A state change invalidates the last successful push, so the health
      // screen shows "out of sync" until the job confirms otherwise.
      syncedAt: null,
      syncError: null,
    },
  });

  await db.user.update({ where: { id: change.userId }, data: { whitelistState: state } });

  await recordAudit(db, actor, {
    action: `whitelist.${state.toLowerCase()}`,
    entityType: 'whitelist',
    entityId: whitelist.id,
    entityLabel: user.publicId,
    before: { state: user.whitelistState },
    after: { state },
    metadata: change.reason == null ? undefined : { reason: change.reason },
  });

  return {
    whitelist,
    playerPublicId: user.publicId,
    discordId: eventDiscordId(user.discordAccount?.discordId),
  };
}

/** Queue the game-server push and the Discord role mirror inside the deciding transaction. */
async function queueSync(tx: Db, userId: string, reason: string): Promise<void> {
  await enqueueDurable('fivem.whitelist.sync', { userId, reason }, { db: tx });
  // The Discord Whitelisted role mirrors this state.
  await enqueueDurable('discord.role.sync', { userId, reason }, { db: tx });
}

/** Grant whitelist access. */
export async function grantWhitelist(
  db: Db,
  actor: Actor,
  change: WhitelistChange,
): Promise<Whitelist> {
  return transaction(db, async (tx) => {
    const applied = await applyState(tx, actor, 'APPROVED', change);

    if (change.silent !== true) {
      const copy = notificationCopy.whitelistGranted();
      const notification = await createNotification(tx, { userId: change.userId, ...copy });
      await dispatchPending([notification], tx);
    }

    await refreshOnboardingStep(tx, change.userId);
    await queueSync(tx, change.userId, 'whitelist.granted');

    const source =
      change.sourceSubmissionId === undefined || change.sourceSubmissionId === null
        ? null
        : await tx.applicationSubmission.findUnique({
            where: { id: change.sourceSubmissionId },
            select: { id: true, publicId: true },
          });
    await emitIntegrationEvent(tx, {
      type: 'WHITELIST_APPROVED',
      payload: {
        playerPublicId: applied.playerPublicId,
        discordId: applied.discordId,
        applicationPublicId: source?.publicId ?? null,
      },
      idempotencyKey:
        source === null
          ? `whitelist.approved:${applied.whitelist.id}:${String(Date.now())}`
          : `application.approved:${source.id}`,
      source: actor.source,
    });

    return applied.whitelist;
  });
}

/** Revoke whitelist access. */
export async function revokeWhitelist(
  db: Db,
  actor: Actor,
  change: WhitelistChange,
): Promise<Whitelist> {
  return transaction(db, async (tx) => {
    const applied = await applyState(tx, actor, 'REVOKED', change);

    if (change.silent !== true) {
      const copy = notificationCopy.whitelistRevoked(change.reason ?? null);
      const notification = await createNotification(tx, { userId: change.userId, ...copy });
      await dispatchPending([notification], tx);
    }

    await refreshOnboardingStep(tx, change.userId);
    await queueSync(tx, change.userId, 'whitelist.revoked');
    await emitIntegrationEvent(tx, {
      type: 'WHITELIST_REVOKED',
      payload: {
        playerPublicId: applied.playerPublicId,
        discordId: applied.discordId,
        state: 'REVOKED',
      },
      idempotencyKey: `whitelist.revoked:${applied.whitelist.id}:${String(Date.now())}`,
      source: actor.source,
    });

    return applied.whitelist;
  });
}

/** Suspend access temporarily. Expiry is swept, not scheduled per record. */
export async function suspendWhitelist(
  db: Db,
  actor: Actor,
  change: WhitelistChange & { until: Date },
): Promise<Whitelist> {
  return transaction(db, async (tx) => {
    const applied = await applyState(tx, actor, 'SUSPENDED', change, {
      suspendedUntil: change.until,
    });

    await queueSync(tx, change.userId, 'whitelist.suspended');
    await emitIntegrationEvent(tx, {
      type: 'WHITELIST_REVOKED',
      payload: {
        playerPublicId: applied.playerPublicId,
        discordId: applied.discordId,
        state: 'SUSPENDED',
      },
      idempotencyKey: `whitelist.suspended:${applied.whitelist.id}:${String(Date.now())}`,
      source: actor.source,
    });

    return applied.whitelist;
  });
}

/**
 * Restore suspensions whose window has closed.
 *
 * A sweep rather than a per-record timer: timers are lost on restart, and a
 * suspension that silently never lifts is worse than one that lifts a minute
 * late.
 */
export async function liftExpiredSuspensions(db: Db, actor: Actor): Promise<number> {
  const due = await db.whitelist.findMany({
    where: { state: 'SUSPENDED', suspendedUntil: { not: null, lte: new Date() } },
    select: { userId: true },
  });

  for (const row of due) {
    await grantWhitelist(db, actor, {
      userId: row.userId,
      reason: 'Suspension expired',
      silent: true,
    });
  }

  return due.length;
}

/** Record the outcome of a game-server sync attempt. Called by the worker. */
export async function recordWhitelistSync(
  db: Db,
  userId: string,
  outcome: { ok: boolean; error?: string },
): Promise<void> {
  await db.whitelist.updateMany({
    where: { userId },
    data: outcome.ok
      ? { syncedAt: new Date(), syncFailedAt: null, syncError: null }
      : { syncFailedAt: new Date(), syncError: (outcome.error ?? 'Unknown error').slice(0, 500) },
  });
}

/** Whitelists whose last push failed or never happened, for the health screen. */
export async function unsyncedWhitelists(db: Db): Promise<number> {
  return db.whitelist.count({
    where: { state: { in: ['APPROVED', 'REVOKED', 'SUSPENDED'] }, syncedAt: null },
  });
}
