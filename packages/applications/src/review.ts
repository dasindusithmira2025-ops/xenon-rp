import { ConflictError, NotFoundError, normalisePublicId } from '@xenon/core';
import {
  allocatePublicId,
  type ApplicationComment,
  type ApplicationStatus,
  type ApplicationSubmission,
  type Db,
  type Interview,
  type Prisma,
  transaction,
} from '@xenon/database';
import { grantRoleKeys, grantWhitelist, recordAudit } from '@xenon/domain';
import { enqueueBestEffort } from '@xenon/jobs';
import { createNotification, dispatchPending, notificationCopy } from '@xenon/notifications';
import { type Actor, requirePermission, requireUser } from '@xenon/permissions';

import { assertTransition, isTerminal, staffQueueStatuses } from './state-machine';
import { appendEvent } from './submissions';

/**
 * Application review: the staff half.
 *
 * Every operation here is the shared implementation. The web review screen, the
 * Discord buttons and the bot's slash commands all call these functions, so
 * "approve" means exactly one thing no matter where it was clicked, and the
 * capability check, the state machine, the audit entry and the queued side
 * effects cannot be forgotten by one caller and remembered by another.
 *
 * The ordering rule the whole platform depends on: canonical state commits
 * first, external effects are enqueued afterwards. Discord being unreachable
 * during an approval must cost a message, never the approval.
 */

async function loadForReview(db: Db, reference: string) {
  const normalised = normalisePublicId(reference);
  const submission = await db.applicationSubmission.findFirst({
    where: normalised === null ? { id: reference } : { publicId: normalised },
    include: { template: true, applicant: { select: { id: true, publicId: true } } },
  });
  if (submission === null) throw new NotFoundError('ApplicationSubmission', reference);
  return submission;
}

/**
 * Move a submission to a new status, writing the event and the audit entry.
 *
 * Private, and the only path that changes `status`. Everything public in this
 * file goes through it, which is what keeps the state machine from being
 * something a new code path can simply decline to consult.
 */
async function applyTransition(
  db: Db,
  actor: Actor,
  submissionId: string,
  from: ApplicationStatus,
  to: ApplicationStatus,
  options: {
    action: string;
    eventType: Parameters<typeof appendEvent>[3]['type'];
    publicId: string;
    decisionNote?: string | null;
    extra?: Prisma.ApplicationSubmissionUncheckedUpdateManyInput;
    metadata?: Prisma.InputJsonValue;
    withinTransaction?: (tx: Db) => Promise<void>;
  },
): Promise<ApplicationSubmission> {
  assertTransition(from, to);

  const submission = await transaction(db, async (tx) => {
    const changed = await tx.applicationSubmission.updateMany({
      where: { id: submissionId, status: from },
      data: {
        status: to,
        ...(options.decisionNote === undefined ? {} : { decisionNote: options.decisionNote }),
        ...(isTerminal(to) ? { decidedAt: new Date() } : {}),
        ...options.extra,
      },
    });
    if (changed.count !== 1) throw applicationAlreadyChanged();

    const updated = await tx.applicationSubmission.findUniqueOrThrow({
      where: { id: submissionId },
    });

    await tx.applicationEvent.create({
      data: {
        submissionId,
        type: options.eventType,
        actorId: actor.userId,
        source: actor.source,
        fromStatus: from,
        toStatus: to,
        ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
      },
    });

    await recordAudit(tx, actor, {
      action: options.action,
      entityType: 'application_submission',
      entityId: submissionId,
      entityLabel: options.publicId,
      before: { status: from },
      after: { status: to },
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    });

    await options.withinTransaction?.(tx);

    return updated;
  });

  await enqueueBestEffort('discord.review.update', { submissionId });
  return submission;
}

/**
 * Claim a submission for review.
 *
 * Assignment is advisory, not a lock. A hard lock would strand applications
 * behind whoever opened one and went to bed; showing "currently reviewed by" is
 * enough to stop two people working the same record by accident, and a second
 * reviewer who really does need to take over can.
 */
export async function claimApplication(
  db: Db,
  actor: Actor,
  reference: string,
): Promise<ApplicationSubmission> {
  requirePermission(actor, 'applications.review');
  const userId = requireUser(actor);

  const current = await loadForReview(db, reference);

  if (current.assigneeId !== null && current.assigneeId !== userId) {
    throw new ConflictError(
      `Already assigned to ${current.assigneeId}`,
      'Another reviewer already has this one. Reassign it if you need to take over.',
    );
  }

  // Claiming an already-claimed-by-me submission should not blow up on the
  // state machine when it is already UNDER_REVIEW.
  const needsTransition = current.status !== 'UNDER_REVIEW';

  if (needsTransition) {
    await applyTransition(db, actor, current.id, current.status, 'UNDER_REVIEW', {
      action: 'application.claimed',
      eventType: 'CLAIMED',
      publicId: current.publicId,
      extra: { assigneeId: userId },
      withinTransaction: async (tx) => {
        await tx.applicationReview.create({
          data: {
            submissionId: current.id,
            reviewerId: userId,
            decision: 'CLAIMED',
            source: actor.source,
          },
        });
      },
    });

    const copy = notificationCopy.reviewStarted(current.publicId);
    const notification = await createNotification(db, { userId: current.applicantId, ...copy });
    await dispatchPending([notification]);
  } else {
    await transaction(db, async (tx) => {
      const changed = await tx.applicationSubmission.updateMany({
        where: { id: current.id, status: 'UNDER_REVIEW', assigneeId: current.assigneeId },
        data: { assigneeId: userId },
      });
      if (changed.count !== 1) throw applicationAlreadyChanged();

      await tx.applicationReview.create({
        data: {
          submissionId: current.id,
          reviewerId: userId,
          decision: 'CLAIMED',
          source: actor.source,
        },
      });
    });
  }

  return db.applicationSubmission.findUniqueOrThrow({ where: { id: current.id } });
}

/** Assign or unassign a reviewer. */
export async function assignReviewer(
  db: Db,
  actor: Actor,
  reference: string,
  assigneeId: string | null,
): Promise<ApplicationSubmission> {
  requirePermission(actor, 'applications.assign');

  const current = await loadForReview(db, reference);

  const submission = await transaction(db, async (tx) => {
    const changed = await tx.applicationSubmission.updateMany({
      where: { id: current.id, assigneeId: current.assigneeId },
      data: { assigneeId },
    });
    if (changed.count !== 1) throw applicationAlreadyChanged();

    await appendEvent(tx, actor, current.id, {
      type: assigneeId === null ? 'UNCLAIMED' : 'ASSIGNED',
      metadata: { assigneeId },
    });

    await recordAudit(tx, actor, {
      action: 'application.assigned',
      entityType: 'application_submission',
      entityId: current.id,
      entityLabel: current.publicId,
      before: { assigneeId: current.assigneeId },
      after: { assigneeId },
    });

    return tx.applicationSubmission.findUniqueOrThrow({ where: { id: current.id } });
  });

  await enqueueBestEffort('discord.review.update', { submissionId: current.id });
  return submission;
}

export interface DecisionInput {
  readonly reference: string;
  readonly publicNote?: string | null;
  readonly staffNote?: string | null;
}

/** Send an application back to the applicant for edits. */
export async function requestChanges(
  db: Db,
  actor: Actor,
  input: DecisionInput & { publicNote: string },
): Promise<ApplicationSubmission> {
  requirePermission(actor, 'applications.request_changes');
  const userId = requireUser(actor);

  const current = await loadForReview(db, input.reference);

  const submission = await applyTransition(
    db,
    actor,
    current.id,
    current.status,
    'CHANGES_REQUESTED',
    {
      action: 'application.changes_requested',
      eventType: 'CHANGES_REQUESTED',
      publicId: current.publicId,
      decisionNote: input.publicNote,
      // The applicant needs time to act on the feedback; without this the
      // expiry sweep would close the application while they were editing it.
      extra:
        current.template.expiryDays > 0
          ? { expiresAt: new Date(Date.now() + current.template.expiryDays * 86_400_000) }
          : {},
      withinTransaction: async (tx) => {
        await tx.applicationReview.create({
          data: {
            submissionId: current.id,
            reviewerId: userId,
            decision: 'CHANGES_REQUESTED',
            publicNote: input.publicNote,
            staffNote: input.staffNote ?? null,
            source: actor.source,
          },
        });
      },
    },
  );

  const copy = notificationCopy.changesRequested(current.publicId, input.publicNote);
  const notification = await createNotification(db, { userId: current.applicantId, ...copy });
  await dispatchPending([notification]);

  return submission;
}

/** Move an application to the interview stage. */
export async function requestInterview(
  db: Db,
  actor: Actor,
  input: DecisionInput,
): Promise<ApplicationSubmission> {
  requirePermission(actor, 'applications.interview');
  const userId = requireUser(actor);

  const current = await loadForReview(db, input.reference);

  const submission = await applyTransition(
    db,
    actor,
    current.id,
    current.status,
    'INTERVIEW_REQUIRED',
    {
      action: 'application.interview_requested',
      eventType: 'INTERVIEW_REQUESTED',
      publicId: current.publicId,
      decisionNote: input.publicNote ?? null,
      withinTransaction: async (tx) => {
        const publicId = await allocatePublicId(tx, 'interview');
        await tx.interview.create({
          data: {
            publicId,
            submissionId: current.id,
            applicantId: current.applicantId,
            status: 'REQUESTED',
            notes: input.publicNote ?? null,
          },
        });
        await tx.applicationReview.create({
          data: {
            submissionId: current.id,
            reviewerId: userId,
            decision: 'INTERVIEW_REQUESTED',
            publicNote: input.publicNote ?? null,
            staffNote: input.staffNote ?? null,
            source: actor.source,
          },
        });
      },
    },
  );

  const copy = notificationCopy.interviewRequested(current.publicId, input.publicNote ?? null);
  const notification = await createNotification(db, { userId: current.applicantId, ...copy });
  await dispatchPending([notification]);

  return submission;
}

/** Put a time and place on a requested interview. */
export async function scheduleInterview(
  db: Db,
  actor: Actor,
  input: {
    reference: string;
    scheduledFor: Date;
    location?: string | null;
    hostId?: string | null;
  },
): Promise<Interview> {
  requirePermission(actor, 'applications.interview');

  const current = await loadForReview(db, input.reference);

  const interview = await db.interview.findFirst({
    where: { submissionId: current.id },
    orderBy: { createdAt: 'desc' },
  });
  if (interview === null) {
    throw new ConflictError(
      'No interview requested',
      'Request an interview before scheduling one.',
    );
  }

  const updated = await db.interview.update({
    where: { id: interview.id },
    data: {
      status: 'SCHEDULED',
      scheduledFor: input.scheduledFor,
      location: input.location ?? null,
      hostId: input.hostId ?? actor.userId,
    },
  });

  if (current.status !== 'INTERVIEW_SCHEDULED') {
    await applyTransition(db, actor, current.id, current.status, 'INTERVIEW_SCHEDULED', {
      action: 'application.interview_scheduled',
      eventType: 'INTERVIEW_SCHEDULED',
      publicId: current.publicId,
      metadata: { scheduledFor: input.scheduledFor.toISOString() },
    });
  }

  const copy = notificationCopy.interviewScheduled(
    current.publicId,
    input.scheduledFor,
    input.location ?? null,
  );
  const notification = await createNotification(db, { userId: current.applicantId, ...copy });
  await dispatchPending([notification]);

  return updated;
}

/** Record the outcome of an interview and return the application to review. */
export async function completeInterview(
  db: Db,
  actor: Actor,
  input: {
    reference: string;
    outcome: 'PASSED' | 'FAILED' | 'INCONCLUSIVE';
    notes?: string | null;
  },
): Promise<ApplicationSubmission> {
  requirePermission(actor, 'applications.interview');

  const current = await loadForReview(db, input.reference);

  const interview = await db.interview.findFirst({
    where: { submissionId: current.id },
    orderBy: { createdAt: 'desc' },
  });
  if (interview !== null) {
    await db.interview.update({
      where: { id: interview.id },
      data: {
        status: 'COMPLETED',
        outcome: input.outcome,
        notes: input.notes ?? null,
        completedAt: new Date(),
      },
    });
  }

  return applyTransition(db, actor, current.id, current.status, 'INTERVIEW_COMPLETED', {
    action: 'application.interview_completed',
    eventType: 'INTERVIEW_COMPLETED',
    publicId: current.publicId,
    metadata: { outcome: input.outcome },
  });
}

/**
 * Approve an application.
 *
 * The shared implementation of everything approval confers: the status, the
 * roles the template grants, the whitelist when it grants one, the applicant's
 * notification, the audit entry. Web, Discord and bot all land here.
 *
 * Roles and whitelist are applied inside the same transaction as the status, so
 * an approval can never be recorded without the access it promises. Discord and
 * FXServer are told afterwards, by queued jobs that retry.
 */
export async function approveApplication(
  db: Db,
  actor: Actor,
  input: DecisionInput,
): Promise<ApplicationSubmission> {
  requirePermission(actor, 'applications.approve');
  const userId = requireUser(actor);

  const current = await loadForReview(db, input.reference);
  assertTransition(current.status, 'APPROVED');

  const submission = await transaction(db, async (tx) => {
    const changed = await tx.applicationSubmission.updateMany({
      where: { id: current.id, status: current.status },
      data: {
        status: 'APPROVED',
        decidedAt: new Date(),
        decisionNote: input.publicNote ?? null,
        assigneeId: current.assigneeId ?? userId,
      },
    });
    if (changed.count !== 1) throw applicationAlreadyChanged();

    const updated = await tx.applicationSubmission.findUniqueOrThrow({
      where: { id: current.id },
    });

    await tx.applicationEvent.create({
      data: {
        submissionId: current.id,
        type: 'APPROVED',
        actorId: actor.userId,
        source: actor.source,
        fromStatus: current.status,
        toStatus: 'APPROVED',
      },
    });

    await tx.applicationReview.create({
      data: {
        submissionId: current.id,
        reviewerId: userId,
        decision: 'APPROVED',
        publicNote: input.publicNote ?? null,
        staffNote: input.staffNote ?? null,
        source: actor.source,
      },
    });

    await grantRoleKeys(tx, current.applicantId, current.template.grantRoleKeys);

    if (current.template.grantsWhitelist) {
      await grantWhitelist(tx, actor, {
        userId: current.applicantId,
        reason: `Approved via ${current.publicId}`,
        sourceSubmissionId: current.id,
        // The approval notification already says they are in; a second message
        // saying the same thing is noise.
        silent: true,
      });
    }

    await recordAudit(tx, actor, {
      action: 'application.approved',
      entityType: 'application_submission',
      entityId: current.id,
      entityLabel: current.publicId,
      before: { status: current.status },
      after: { status: 'APPROVED' },
      metadata: {
        grantedRoles: current.template.grantRoleKeys,
        grantsWhitelist: current.template.grantsWhitelist,
      },
    });

    return updated;
  });

  const copy = notificationCopy.approved(
    current.publicId,
    current.template.name,
    input.publicNote ?? null,
  );
  const notification = await createNotification(db, { userId: current.applicantId, ...copy });
  await dispatchPending([notification]);

  await enqueueBestEffort('discord.review.update', { submissionId: current.id });
  await enqueueBestEffort('discord.role.sync', {
    userId: current.applicantId,
    reason: `application.approved:${current.publicId}`,
  });
  if (current.template.grantsWhitelist) {
    await enqueueBestEffort('fivem.whitelist.sync', {
      userId: current.applicantId,
      reason: `application.approved:${current.publicId}`,
    });
  }

  return submission;
}

function applicationAlreadyChanged(): ConflictError {
  return new ConflictError(
    'APPLICATION_ALREADY_CHANGED',
    'This application was already updated. Refresh it before taking another action.',
  );
}

/** Reject an application. The reason is mandatory and is shown to the applicant. */
export async function rejectApplication(
  db: Db,
  actor: Actor,
  input: DecisionInput & { publicNote: string },
): Promise<ApplicationSubmission> {
  requirePermission(actor, 'applications.reject');
  const userId = requireUser(actor);

  const current = await loadForReview(db, input.reference);

  const submission = await applyTransition(db, actor, current.id, current.status, 'REJECTED', {
    action: 'application.rejected',
    eventType: 'REJECTED',
    publicId: current.publicId,
    decisionNote: input.publicNote,
    extra: { assigneeId: current.assigneeId ?? userId },
    withinTransaction: async (tx) => {
      await tx.applicationReview.create({
        data: {
          submissionId: current.id,
          reviewerId: userId,
          decision: 'REJECTED',
          publicNote: input.publicNote,
          staffNote: input.staffNote ?? null,
          source: actor.source,
        },
      });
    },
  });

  const copy = notificationCopy.rejected(current.publicId, input.publicNote);
  const notification = await createNotification(db, { userId: current.applicantId, ...copy });
  await dispatchPending([notification]);

  return submission;
}

/** Add a staff note or a message the applicant can read. */
export async function addComment(
  db: Db,
  actor: Actor,
  input: { reference: string; body: string; visibility: 'INTERNAL' | 'APPLICANT' },
): Promise<ApplicationComment> {
  requirePermission(actor, 'applications.review');
  const userId = requireUser(actor);

  const current = await loadForReview(db, input.reference);

  const comment = await db.applicationComment.create({
    data: {
      submissionId: current.id,
      authorId: userId,
      body: input.body,
      visibility: input.visibility,
    },
  });

  await appendEvent(db, actor, current.id, {
    type: input.visibility === 'INTERNAL' ? 'NOTE_ADDED' : 'COMMENTED',
  });

  return comment;
}

/** Comments on a submission, filtered by who is asking. */
export async function listComments(db: Db, submissionId: string, asStaff: boolean) {
  return db.applicationComment.findMany({
    where: {
      submissionId,
      deletedAt: null,
      ...(asStaff ? {} : { visibility: 'APPLICANT' }),
    },
    orderBy: { createdAt: 'asc' },
    include: { author: { select: { publicId: true, displayName: true, avatarUrl: true } } },
  });
}

export interface QueueQuery {
  readonly status?: ApplicationStatus;
  readonly templateId?: string;
  readonly assigneeId?: string | null;
  readonly search?: string;
  readonly skip?: number;
  readonly take?: number;
}

/**
 * The staff review queue.
 *
 * Defaults to everything waiting on staff, oldest first: the queue exists to
 * answer "what should I pick up next", and newest-first would starve the people
 * who have waited longest.
 */
export async function listReviewQueue(db: Db, actor: Actor, query: QueueQuery = {}) {
  requirePermission(actor, 'applications.view');

  const take = Math.min(query.take ?? 25, 100);

  const where: Prisma.ApplicationSubmissionWhereInput = {
    ...(query.status === undefined
      ? { status: { in: [...staffQueueStatuses] } }
      : { status: query.status }),
    ...(query.templateId === undefined ? {} : { templateId: query.templateId }),
    ...(query.assigneeId === undefined ? {} : { assigneeId: query.assigneeId }),
    ...(query.search === undefined || query.search.length === 0
      ? {}
      : {
          OR: [
            { publicId: { contains: query.search.toUpperCase() } },
            { applicant: { displayName: { contains: query.search, mode: 'insensitive' } } },
            { applicant: { publicId: { contains: query.search.toUpperCase() } } },
          ],
        }),
  };

  const [items, total] = await Promise.all([
    db.applicationSubmission.findMany({
      where,
      orderBy: [{ submittedAt: 'asc' }, { createdAt: 'asc' }],
      skip: query.skip ?? 0,
      take,
      include: {
        template: { select: { name: true, slug: true, publicIdPrefix: true } },
        applicant: {
          select: {
            publicId: true,
            displayName: true,
            avatarUrl: true,
            discordAccount: { select: { username: true } },
          },
        },
        assignee: { select: { publicId: true, displayName: true, avatarUrl: true } },
        character: { select: { firstName: true, lastName: true } },
      },
    }),
    db.applicationSubmission.count({ where }),
  ]);

  return { items, total };
}

/** Counts per status, for the control-centre overview tiles. */
export async function queueCounts(db: Db): Promise<Record<string, number>> {
  const grouped = await db.applicationSubmission.groupBy({
    by: ['status'],
    _count: { _all: true },
  });

  const counts: Record<string, number> = {};
  for (const row of grouped) counts[row.status] = row._count._all;
  return counts;
}
