import { ConflictError, NotFoundError, normalisePublicId } from '@xenon/core';
import {
  type Appeal,
  type AppealStatus,
  allocatePublicId,
  type Db,
  type Prisma,
} from '@xenon/database';
import { enforceRateLimit } from '@xenon/jobs';
import { createNotification, dispatchPending, notificationCopy } from '@xenon/notifications';
import {
  type Actor,
  requireOwnerOrPermission,
  requirePermission,
  requireUser,
} from '@xenon/permissions';
import type { AppealInput } from '@xenon/validation';

import { recordAudit } from './audit';
import { hashIp } from './hashing';

/**
 * Appeals.
 *
 * The one workflow a sanctioned account must still be able to use. Everything
 * else checks `status === 'ACTIVE'`; this deliberately does not, because an
 * appeal process a banned player cannot reach is not an appeal process.
 */

/** Transitions a decision may make. Anything else is rejected. */
const ALLOWED_TRANSITIONS: Record<AppealStatus, readonly AppealStatus[]> = {
  SUBMITTED: ['UNDER_REVIEW', 'AWAITING_INFO', 'ACCEPTED', 'DENIED', 'WITHDRAWN'],
  UNDER_REVIEW: ['AWAITING_INFO', 'ACCEPTED', 'DENIED', 'WITHDRAWN'],
  AWAITING_INFO: ['UNDER_REVIEW', 'ACCEPTED', 'DENIED', 'WITHDRAWN'],
  ACCEPTED: [],
  DENIED: [],
  WITHDRAWN: [],
};

export async function createAppeal(
  db: Db,
  actor: Actor,
  input: AppealInput,
  context: { ip?: string | null } = {},
): Promise<Appeal> {
  const userId = requireUser(actor);
  await enforceRateLimit('appealCreate', userId);

  // One live appeal at a time. Without this, a denied appeal is followed by
  // five more within the hour and the queue becomes unusable.
  const open = await db.appeal.count({
    where: { authorId: userId, status: { in: ['SUBMITTED', 'UNDER_REVIEW', 'AWAITING_INFO'] } },
  });
  if (open > 0) {
    throw new ConflictError(
      'An appeal is already open',
      'You already have an appeal under review. Wait for a decision before filing another.',
    );
  }

  const publicId = await allocatePublicId(db, 'appeal');

  const appeal = await db.appeal.create({
    data: {
      publicId,
      authorId: userId,
      kind: input.kind,
      statement: input.statement,
      sanctionRef: input.sanctionRef ?? null,
      mediaIds: input.mediaIds,
      createdIpHash: hashIp(context.ip),
    },
  });

  await recordAudit(db, actor, {
    action: 'appeal.created',
    entityType: 'appeal',
    entityId: appeal.id,
    entityLabel: appeal.publicId,
    after: { kind: appeal.kind },
  });

  return appeal;
}

export async function decideAppeal(
  db: Db,
  actor: Actor,
  input: { appealId: string; status: AppealStatus; decision: string },
): Promise<Appeal> {
  requirePermission(actor, 'appeals.manage');

  const before = await db.appeal.findUnique({ where: { id: input.appealId } });
  if (before === null) throw new NotFoundError('Appeal', input.appealId);

  if (!ALLOWED_TRANSITIONS[before.status].includes(input.status)) {
    throw new ConflictError(
      `Cannot move appeal from ${before.status} to ${input.status}`,
      'That appeal has already been decided.',
    );
  }

  const decided = input.status === 'ACCEPTED' || input.status === 'DENIED';

  const appeal = await db.appeal.update({
    where: { id: input.appealId },
    data: {
      status: input.status,
      decision: input.decision,
      assigneeId: before.assigneeId ?? actor.userId,
      ...(decided ? { decidedAt: new Date() } : {}),
    },
  });

  await recordAudit(db, actor, {
    action: 'appeal.decided',
    entityType: 'appeal',
    entityId: appeal.id,
    entityLabel: appeal.publicId,
    before: { status: before.status },
    after: { status: appeal.status },
    metadata: { decision: input.decision },
  });

  if (decided) {
    const copy = notificationCopy.appealDecision(
      appeal.publicId,
      input.status === 'ACCEPTED',
      input.decision,
    );
    const notification = await createNotification(db, { userId: appeal.authorId, ...copy });
    await dispatchPending([notification]);
  }

  return appeal;
}

/** Withdraw one's own appeal. */
export async function withdrawAppeal(db: Db, actor: Actor, appealId: string): Promise<Appeal> {
  const appeal = await db.appeal.findUnique({ where: { id: appealId } });
  if (appeal === null) throw new NotFoundError('Appeal', appealId);

  requireOwnerOrPermission(actor, appeal.authorId, 'appeals.manage');

  if (!ALLOWED_TRANSITIONS[appeal.status].includes('WITHDRAWN')) {
    throw new ConflictError('Appeal already decided', 'That appeal has already been decided.');
  }

  const updated = await db.appeal.update({
    where: { id: appealId },
    data: { status: 'WITHDRAWN', decidedAt: new Date() },
  });

  await recordAudit(db, actor, {
    action: 'appeal.withdrawn',
    entityType: 'appeal',
    entityId: appealId,
    entityLabel: appeal.publicId,
    before: { status: appeal.status },
  });

  return updated;
}

export async function getAppeal(db: Db, actor: Actor, publicIdOrId: string) {
  const normalised = normalisePublicId(publicIdOrId, 'AP');
  const appeal = await db.appeal.findFirst({
    where: normalised === null ? { id: publicIdOrId } : { publicId: normalised },
    select: { id: true, authorId: true },
  });
  if (appeal === null) throw new NotFoundError('Appeal', publicIdOrId);

  requireOwnerOrPermission(actor, appeal.authorId, 'appeals.view');

  return db.appeal.findUnique({
    where: { id: appeal.id },
    include: {
      author: {
        select: {
          publicId: true,
          displayName: true,
          avatarUrl: true,
          status: true,
          whitelistState: true,
        },
      },
      assignee: { select: { publicId: true, displayName: true } },
    },
  });
}

export interface AppealQuery {
  readonly status?: AppealStatus;
  readonly authorId?: string;
  readonly search?: string;
  readonly skip?: number;
  readonly take?: number;
}

export async function listAppeals(db: Db, query: AppealQuery = {}) {
  const take = Math.min(query.take ?? 25, 100);

  const where: Prisma.AppealWhereInput = {
    ...(query.status === undefined ? {} : { status: query.status }),
    ...(query.authorId === undefined ? {} : { authorId: query.authorId }),
    ...(query.search === undefined || query.search.length === 0
      ? {}
      : { publicId: { contains: query.search.toUpperCase() } }),
  };

  const [items, total] = await Promise.all([
    db.appeal.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      skip: query.skip ?? 0,
      take,
      include: {
        author: { select: { publicId: true, displayName: true, avatarUrl: true } },
        assignee: { select: { publicId: true, displayName: true } },
      },
    }),
    db.appeal.count({ where }),
  ]);

  return { items, total };
}
