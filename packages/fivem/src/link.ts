import { ForbiddenError, NotFoundError } from '@xenon/core';
import type { Db, GameIdentity } from '@xenon/database';
import { recordAudit, refreshOnboardingStep } from '@xenon/domain';
import { enqueueDurable } from '@xenon/jobs';
import { type Actor, requirePermission } from '@xenon/permissions';

/**
 * Game identity maintenance.
 *
 * Players link their FiveM (Cfx.re) account on the website - see `cfx.ts`.
 * The older "type a code in game" flow is retired; its `link_tokens` rows are
 * only pruned now.
 */

/** Unlink an identity. The row is kept, marked unlinked, for audit. */
export async function unlinkIdentity(
  db: Db,
  actor: Actor,
  identityId: string,
): Promise<GameIdentity> {
  const identity = await db.gameIdentity.findUnique({ where: { id: identityId } });
  if (identity === null) throw new NotFoundError('GameIdentity', identityId);

  if (identity.userId !== actor.userId) {
    requirePermission(actor, 'players.manage');
  } else {
    // A sanctioned player may not free the identity the gate refuses them by.
    const owner = await db.user.findUnique({
      where: { id: identity.userId },
      select: { status: true },
    });
    if (owner?.status !== 'ACTIVE') throw new ForbiddenError('identity unlink while sanctioned');
  }

  const updated = await db.gameIdentity.update({
    where: { id: identityId },
    data: { unlinkedAt: new Date(), isPrimary: false },
  });

  await recordAudit(db, actor, {
    action: 'game_identity.unlinked',
    entityType: 'user',
    entityId: identity.userId,
    before: { kind: identity.kind },
  });
  await enqueueDurable('fivem.whitelist.sync', {
    userId: identity.userId,
    reason: 'identity.unlinked',
  });

  await refreshOnboardingStep(db, identity.userId);
  return updated;
}

/** Delete spent and expired legacy link codes. Called by the maintenance sweep. */
export async function pruneLinkTokens(db: Db): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const result = await db.linkToken.deleteMany({
    where: { OR: [{ expiresAt: { lt: cutoff } }, { consumedAt: { lt: cutoff } }] },
  });
  return result.count;
}
