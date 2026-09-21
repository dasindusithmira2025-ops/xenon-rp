import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  normalisePublicId,
  ValidationError,
} from '@xenon/core';
import {
  allocatePublicId,
  type ApplicationEventType,
  type ApplicationStatus,
  type ApplicationSubmission,
  type Db,
  type Prisma,
  transaction,
} from '@xenon/database';
import { recordAudit } from '@xenon/domain';
import { enforceRateLimit, enqueueBestEffort } from '@xenon/jobs';
import { createNotification, dispatchPending, notificationCopy } from '@xenon/notifications';
import { type Actor, can, requireUser } from '@xenon/permissions';
import {
  type AnswerMap,
  type AutosaveInput,
  submissionProgress,
  validateSubmission,
} from '@xenon/validation';

import { checkEligibility } from './eligibility';
import {
  flattenQuestions,
  type RenderableSection,
  toAnswerColumns,
  toAnswerMap,
  toRenderableSections,
} from './form-model';
import { assertTransition, isEditableByApplicant } from './state-machine';

/**
 * Application submissions: the applicant's half of the platform.
 *
 * The thing this file exists to get right is not losing work. A whitelist
 * application is forty minutes of writing, and the failure mode of a naive
 * implementation - a refresh, a laptop lid, a flaky connection - is that all of
 * it disappears. So every answer is persisted server-side as it is typed, under
 * a revision number that detects two tabs fighting, and nothing is ever held
 * only in component state.
 */

const submissionInclude = {
  template: true,
  applicant: {
    select: {
      id: true,
      publicId: true,
      displayName: true,
      avatarUrl: true,
      whitelistState: true,
      createdAt: true,
      discordAccount: { select: { username: true, discordId: true, isGuildMember: true } },
    },
  },
  character: true,
  assignee: { select: { id: true, publicId: true, displayName: true, avatarUrl: true } },
  answers: { include: { question: { select: { key: true } } } },
  events: {
    orderBy: { createdAt: 'asc' },
    include: { actor: { select: { publicId: true, displayName: true } } },
  },
  interviews: { orderBy: { createdAt: 'desc' } },
} satisfies Prisma.ApplicationSubmissionInclude;

export interface AppendEventInput {
  readonly type: ApplicationEventType;
  readonly fromStatus?: ApplicationStatus | null;
  readonly toStatus?: ApplicationStatus | null;
  readonly metadata?: Prisma.InputJsonValue;
}

/** Append one timeline entry. Every state change writes one. */
export async function appendEvent(
  db: Db,
  actor: Actor,
  submissionId: string,
  input: AppendEventInput,
): Promise<void> {
  await db.applicationEvent.create({
    data: {
      submissionId,
      type: input.type,
      actorId: actor.userId,
      source: actor.source,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    },
  });
}

/**
 * Begin an application.
 *
 * Returns the existing draft when there is one rather than creating a second:
 * a player who clicks Apply twice should land back in their half-finished form,
 * not start over.
 */
export async function startApplication(
  db: Db,
  actor: Actor,
  templateSlug: string,
  characterId?: string,
): Promise<ApplicationSubmission> {
  const userId = requireUser(actor);
  await enforceRateLimit('applicationStart', userId);

  const template = await db.applicationTemplate.findUnique({ where: { slug: templateSlug } });
  if (template === null) throw new NotFoundError('ApplicationTemplate', templateSlug);

  const existing = await db.applicationSubmission.findFirst({
    where: {
      templateId: template.id,
      applicantId: userId,
      status: { in: ['DRAFT', 'CHANGES_REQUESTED'] },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (existing !== null) return existing;

  const eligibility = await checkEligibility(db, template, userId);
  if (!eligibility.eligible) {
    const unmet = eligibility.requirements.filter((requirement) => !requirement.met);
    throw new ConflictError(
      `Not eligible for ${templateSlug}: ${unmet.map((r) => r.key).join(', ')}`,
      eligibility.closedReason ?? unmet[0]?.label ?? 'You cannot start this application right now.',
    );
  }

  const publicId = await allocatePublicId(db, 'application', template.publicIdPrefix);

  const submission = await db.applicationSubmission.create({
    data: {
      publicId,
      templateId: template.id,
      applicantId: userId,
      characterId: characterId ?? null,
      status: 'DRAFT',
      expiresAt:
        template.expiryDays > 0 ? new Date(Date.now() + template.expiryDays * 86_400_000) : null,
    },
  });

  await appendEvent(db, actor, submission.id, { type: 'CREATED', toStatus: 'DRAFT' });
  return submission;
}

export type SubmissionWithRelations = Prisma.ApplicationSubmissionGetPayload<{
  include: typeof submissionInclude;
}>;

/** Load one submission by public id or database id. No authorization here. */
async function loadSubmission(db: Db, reference: string): Promise<SubmissionWithRelations> {
  const normalised = normalisePublicId(reference);
  const submission = await db.applicationSubmission.findFirst({
    where: normalised === null ? { id: reference } : { publicId: normalised },
    include: submissionInclude,
  });

  if (submission === null) throw new NotFoundError('ApplicationSubmission', reference);
  return submission;
}

export interface SubmissionView {
  readonly submission: SubmissionWithRelations;
  readonly sections: readonly RenderableSection[];
  readonly answers: AnswerMap;
  readonly progress: { answered: number; total: number; ratio: number };
  readonly editable: boolean;
  readonly errors: Record<string, string[]>;
}

/**
 * Load everything a form or a review screen needs.
 *
 * `asStaff` controls two things at once: whether staff-only questions are
 * included, and whose answers are returned. Keeping the decision in one
 * parameter means a screen cannot accidentally render a staff-only question to
 * an applicant by forgetting a prop.
 */
export async function getSubmissionView(
  db: Db,
  actor: Actor,
  reference: string,
): Promise<SubmissionView> {
  const submission = await loadSubmission(db, reference);

  const isOwner = actor.userId !== null && actor.userId === submission.applicantId;
  const asStaff = can(actor, 'applications.view');
  if (!isOwner && !asStaff) {
    throw new ForbiddenError('applications.view', actor.userId);
  }

  const sections = await db.applicationSection.findMany({
    where: { templateId: submission.templateId },
    orderBy: { sortOrder: 'asc' },
    include: { questions: { orderBy: { sortOrder: 'asc' }, include: { options: true } } },
  });

  const renderable = toRenderableSections(sections, {
    includeStaffOnly: asStaff && !isOwner,
  });
  const questions = flattenQuestions(renderable);
  const answers = toAnswerMap(submission.answers);

  return {
    submission,
    sections: renderable,
    answers,
    progress: submissionProgress(questions, answers),
    editable: isOwner && isEditableByApplicant(submission.status),
    errors: validateSubmission(questions, answers),
  };
}

/**
 * Persist a batch of answers.
 *
 * The revision check is optimistic concurrency, not a lock: two tabs open on
 * the same draft would otherwise silently overwrite each other and the
 * applicant would lose whichever half they were not looking at. On a mismatch
 * the caller is told to reload rather than having their text merged blindly.
 *
 * Answers are written whatever their content - this is a draft, and refusing to
 * save an incomplete sentence is exactly the behaviour that loses work.
 * Validation happens at submit.
 */
export async function autosave(
  db: Db,
  actor: Actor,
  input: AutosaveInput,
): Promise<{ revision: number; savedAt: Date }> {
  const userId = requireUser(actor);
  await enforceRateLimit('applicationAutosave', userId);

  const submission = await db.applicationSubmission.findUnique({
    where: { id: input.submissionId },
    select: { id: true, applicantId: true, status: true, revision: true, templateId: true },
  });
  if (submission === null) throw new NotFoundError('ApplicationSubmission', input.submissionId);

  if (submission.applicantId !== userId) {
    throw new ForbiddenError('applications.edit_own', userId);
  }
  if (!isEditableByApplicant(submission.status)) {
    throw new ConflictError(
      `Cannot edit a submission in ${submission.status}`,
      'This application can no longer be edited.',
    );
  }
  if (submission.revision !== input.revision) {
    throw new ConflictError(
      `Revision mismatch: client ${String(input.revision)}, server ${String(submission.revision)}`,
      'This application was edited somewhere else. Reload to see the latest version.',
    );
  }

  const questions = await db.applicationQuestion.findMany({
    where: { section: { templateId: submission.templateId } },
    select: { id: true, key: true, type: true, staffOnly: true },
  });
  const byKey = new Map(questions.map((question) => [question.key, question]));

  const savedAt = new Date();

  const updated = await transaction(db, async (tx) => {
    for (const draft of input.answers) {
      const question = byKey.get(draft.questionKey);
      // An unknown key is a stale client or a tampered payload. Skipping it is
      // right either way: there is nothing legitimate to store.
      if (question === undefined || question.staffOnly) continue;

      const columns = toAnswerColumns(question, {
        textValue: draft.textValue,
        numberValue: draft.numberValue,
        booleanValue: draft.booleanValue,
        dateValue: draft.dateValue,
        choiceValues: draft.choiceValues,
        mediaIds: draft.mediaIds,
      });

      await tx.applicationAnswer.upsert({
        where: {
          submissionId_questionId: { submissionId: submission.id, questionId: question.id },
        },
        create: { submissionId: submission.id, questionId: question.id, ...columns },
        update: columns,
      });
    }

    return tx.applicationSubmission.update({
      where: { id: submission.id },
      data: { revision: { increment: 1 }, lastSavedAt: savedAt },
      select: { revision: true },
    });
  });

  return { revision: updated.revision, savedAt };
}

/**
 * Submit, or resubmit after changes were requested.
 *
 * Validation runs server-side against the stored answers, never against the
 * payload the client claims to have. The Discord review card is enqueued after
 * the transaction commits, so a Discord outage delays the notification and not
 * the submission.
 */
export async function submitApplication(
  db: Db,
  actor: Actor,
  submissionId: string,
): Promise<SubmissionWithRelations> {
  const userId = requireUser(actor);
  await enforceRateLimit('applicationSubmit', userId);

  const current = await loadSubmission(db, submissionId);
  if (current.applicantId !== userId) throw new ForbiddenError('applications.edit_own', userId);

  const resubmission = current.status === 'CHANGES_REQUESTED';
  const target: ApplicationStatus = resubmission ? 'RESUBMITTED' : 'SUBMITTED';
  assertTransition(current.status, target);

  const sections = await db.applicationSection.findMany({
    where: { templateId: current.templateId },
    orderBy: { sortOrder: 'asc' },
    include: { questions: { orderBy: { sortOrder: 'asc' }, include: { options: true } } },
  });

  const questions = flattenQuestions(toRenderableSections(sections, { includeStaffOnly: false }));
  const answers = toAnswerMap(current.answers);
  const errors = validateSubmission(questions, answers);

  if (Object.keys(errors).length > 0) {
    throw new ValidationError(errors, 'Submission is incomplete');
  }

  const now = new Date();
  await transaction(db, async (tx) => {
    await tx.applicationSubmission.update({
      where: { id: current.id },
      data: {
        status: target,
        submittedAt: now,
        ...(resubmission ? { attempt: { increment: 1 } } : {}),
        // The expiry clock restarts on submission: the window exists to close
        // abandoned drafts, not to punish a queue that is running slowly.
        expiresAt:
          current.template.expiryDays > 0
            ? new Date(now.getTime() + current.template.expiryDays * 86_400_000)
            : null,
      },
    });

    await tx.applicationEvent.create({
      data: {
        submissionId: current.id,
        type: resubmission ? 'RESUBMITTED' : 'SUBMITTED',
        actorId: actor.userId,
        source: actor.source,
        fromStatus: current.status,
        toStatus: target,
      },
    });
  });

  await recordAudit(db, actor, {
    action: resubmission ? 'application.resubmitted' : 'application.submitted',
    entityType: 'application_submission',
    entityId: current.id,
    entityLabel: current.publicId,
    before: { status: current.status },
    after: { status: target },
  });

  const copy = notificationCopy.applicationSubmitted(current.publicId, current.template.name);
  const notification = await createNotification(db, { userId, ...copy });
  await dispatchPending([notification]);

  await enqueueBestEffort('discord.review.post', { submissionId: current.id });

  return loadSubmission(db, current.id);
}

/** Withdraw one's own application. */
export async function withdrawApplication(
  db: Db,
  actor: Actor,
  submissionId: string,
): Promise<ApplicationSubmission> {
  const userId = requireUser(actor);
  const current = await loadSubmission(db, submissionId);
  if (current.applicantId !== userId) throw new ForbiddenError('applications.edit_own', userId);

  assertTransition(current.status, 'WITHDRAWN');

  const submission = await db.applicationSubmission.update({
    where: { id: current.id },
    data: { status: 'WITHDRAWN', decidedAt: new Date() },
  });

  await appendEvent(db, actor, current.id, {
    type: 'WITHDRAWN',
    fromStatus: current.status,
    toStatus: 'WITHDRAWN',
  });

  await recordAudit(db, actor, {
    action: 'application.withdrawn',
    entityType: 'application_submission',
    entityId: current.id,
    entityLabel: current.publicId,
    before: { status: current.status },
    after: { status: 'WITHDRAWN' },
  });

  await enqueueBestEffort('discord.review.update', { submissionId: current.id });

  return submission;
}

/** A player's own applications, newest first. */
export async function listOwnSubmissions(db: Db, userId: string) {
  return db.applicationSubmission.findMany({
    where: { applicantId: userId },
    orderBy: { createdAt: 'desc' },
    include: {
      template: { select: { name: true, slug: true, summary: true } },
      character: { select: { firstName: true, lastName: true } },
    },
  });
}

/**
 * Close applications that have sat past their window.
 *
 * Run by the scheduled sweep. `systemActor` holds no capabilities, so this
 * cannot become a path to an unattended approval.
 */
export async function expireStaleSubmissions(db: Db, actor: Actor): Promise<number> {
  const due = await db.applicationSubmission.findMany({
    where: {
      expiresAt: { not: null, lte: new Date() },
      status: { notIn: ['APPROVED', 'REJECTED', 'WITHDRAWN', 'EXPIRED', 'ARCHIVED'] },
    },
    select: { id: true, publicId: true, status: true, applicantId: true },
  });

  for (const submission of due) {
    await db.applicationSubmission.update({
      where: { id: submission.id },
      data: { status: 'EXPIRED', decidedAt: new Date() },
    });

    await appendEvent(db, actor, submission.id, {
      type: 'EXPIRED',
      fromStatus: submission.status,
      toStatus: 'EXPIRED',
    });

    const copy = notificationCopy.expired(submission.publicId);
    const notification = await createNotification(db, {
      userId: submission.applicantId,
      ...copy,
    });
    await dispatchPending([notification]);
  }

  return due.length;
}
