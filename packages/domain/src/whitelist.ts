import { NotFoundError } from '@xenon/core';
import type { Db, Whitelist, WhitelistState } from '@xenon/database';
import { enqueueBestEffort } from '@xenon/jobs';
import { createNotification, dispatchPending, notificationCopy } from '@xenon/notifications';
import type { Actor } from '@xenon/permissions';

import { recordAudit } from './audit';
import { refreshOnboardingStep } from './users';

/**
 * Whitelist state.
 *
 * `Whitelist` is authoritative and `User.whitelistState` mirrors it for cheap
 * gating reads; both are written in the same statement so they cannot disagree.
 * The game server learns about the change from a queued job, never from an
 * inline call - an FXServer restart must not be able to fail an approval.
 */

export interface WhitelistChange {
  readonly userId: string;
  readonly reason?: string | null;
  /** The application that produced the grant, when there was one. */
  readonly sourceSubmissionId?: string | null;
  /** Suppress the player notification when the caller sends its own. */
  readonly silent?: boolean;
}

async function applyState(
  db: Db,
  actor: Actor,
  state: WhitelistState,
  change: WhitelistChange,
  extra: { suspendedUntil?: Date | null } = {},
): Promise<Whitelist> {
  const user = await db.user.findUnique({
    where: { id: change.userId },
    select: { publicId: true, whitelistState: true },
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

  return whitelist;
}

/** Grant whitelist access. */
export async function grantWhitelist(
  db: Db,
  actor: Actor,
  change: WhitelistChange,
): Promise<Whitelist> {
  const whitelist = await applyState(db, actor, 'APPROVED', change);

  if (change.silent !== true) {
    const copy = notificationCopy.whitelistGranted();
    const notification = await createNotification(db, { userId: change.userId, ...copy });
    await dispatchPending([notification]);
  }

  await refreshOnboardingStep(db, change.userId);
  await enqueueBestEffort('fivem.whitelist.sync', {
    userId: change.userId,
    reason: 'whitelist.granted',
  });
  // The Discord Whitelisted role mirrors this state.
  await enqueueBestEffort('discord.role.sync', {
    userId: change.userId,
    reason: 'whitelist.granted',
  });

  return whitelist;
}

/** Revoke whitelist access. */
export async function revokeWhitelist(
  db: Db,
  actor: Actor,
  change: WhitelistChange,
): Promise<Whitelist> {
  const whitelist = await applyState(db, actor, 'REVOKED', change);

  if (change.silent !== true) {
    const copy = notificationCopy.whitelistRevoked(change.reason ?? null);
    const notification = await createNotification(db, { userId: change.userId, ...copy });
    await dispatchPending([notification]);
  }

  await refreshOnboardingStep(db, change.userId);
  await enqueueBestEffort('fivem.whitelist.sync', {
    userId: change.userId,
    reason: 'whitelist.revoked',
  });
  // The Discord Whitelisted role mirrors this state.
  await enqueueBestEffort('discord.role.sync', {
    userId: change.userId,
    reason: 'whitelist.revoked',
  });

  return whitelist;
}

/** Suspend access temporarily. Expiry is swept, not scheduled per record. */
export async function suspendWhitelist(
  db: Db,
  actor: Actor,
  change: WhitelistChange & { until: Date },
): Promise<Whitelist> {
  const whitelist = await applyState(db, actor, 'SUSPENDED', change, {
    suspendedUntil: change.until,
  });

  await enqueueBestEffort('fivem.whitelist.sync', {
    userId: change.userId,
    reason: 'whitelist.suspended',
  });
  // The Discord Whitelisted role mirrors this state.
  await enqueueBestEffort('discord.role.sync', {
    userId: change.userId,
    reason: 'whitelist.suspended',
  });

  return whitelist;
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
