import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  approveApplication,
  autosave,
  getSubmissionView,
  rejectApplication,
  requestChanges,
  startApplication,
  submitApplication,
  withdrawApplication,
} from '@xenon/applications';
import { ForbiddenError } from '@xenon/core';

import {
  actorFor,
  auditActions,
  createActor,
  createTemplate,
  createUser,
  eventTypes,
  fillRequiredAnswers,
  prisma,
  resetDatabase,
} from './harness';

/**
 * The whole application journey, against a real database.
 *
 * This is the path the platform exists to serve, so it is tested end to end in
 * one test rather than as eight isolated units: the interesting failures are
 * the ones between the steps - an approval that grants the status but not the
 * whitelist, a resubmission that loses the applicant's edits, an audit trail
 * with a hole in it - and none of those are visible from inside a single step.
 */

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
});

describe('application lifecycle', () => {
  it('carries a draft through changes and resubmission to an approval that grants access', async () => {
    const template = await createTemplate({
      grantsWhitelist: true,
      grantRoleKeys: ['member'],
      expiryDays: 30,
    });
    const { user: applicant, actor: applicantActor } = await createActor({
      displayName: 'Fixture Applicant',
    });
    const { actor: reviewer } = await createActor({
      displayName: 'Fixture Reviewer',
      roleKeys: ['reviewer'],
    });

    // --- Start -------------------------------------------------------------
    const draft = await startApplication(prisma, applicantActor, template.slug);
    expect(draft.status).toBe('DRAFT');
    expect(draft.publicId).toMatch(/^XN-WL-\d+$/);

    // Clicking Apply again returns the same draft rather than opening a second.
    const again = await startApplication(prisma, applicantActor, template.slug);
    expect(again.id).toBe(draft.id);

    // --- Autosave ----------------------------------------------------------
    const answers = await fillRequiredAnswers(prisma, draft.id);
    const first = await autosave(prisma, applicantActor, {
      submissionId: draft.id,
      revision: 0,
      answers,
    });
    expect(first.revision).toBe(1);

    // The revision the client last saw is the one it must send back. This is
    // what stops a second tab silently overwriting the first tab's work.
    await expect(
      autosave(prisma, applicantActor, { submissionId: draft.id, revision: 0, answers }),
    ).rejects.toThrow(/edited somewhere else|Revision mismatch/i);

    // --- Submit ------------------------------------------------------------
    const submitted = await submitApplication(prisma, applicantActor, draft.id);
    expect(submitted.status).toBe('SUBMITTED');

    // --- Changes requested -------------------------------------------------
    await requestChanges(prisma, reviewer, {
      reference: submitted.publicId,
      publicNote: 'Please expand on your roleplay experience.',
    });

    const afterChanges = await prisma.applicationSubmission.findUniqueOrThrow({
      where: { id: draft.id },
    });
    expect(afterChanges.status).toBe('CHANGES_REQUESTED');

    // The applicant was told, in the product's own notification system.
    const notifications = await prisma.notification.findMany({
      where: { userId: applicant.id },
    });
    expect(notifications.some((row) => row.body.includes('expand on your roleplay'))).toBe(true);

    // --- Edit and resubmit -------------------------------------------------
    const edited = answers.map((answer) => ({
      ...answer,
      textValue: `${answer.textValue} Now with considerably more detail about my experience.`,
    }));
    const saved = await autosave(prisma, applicantActor, {
      submissionId: draft.id,
      revision: afterChanges.revision,
      answers: edited,
    });
    expect(saved.revision).toBe(afterChanges.revision + 1);

    const resubmitted = await submitApplication(prisma, applicantActor, draft.id);
    expect(resubmitted.status).toBe('RESUBMITTED');
    expect(resubmitted.attempt).toBe(2);

    // --- Approve -----------------------------------------------------------
    await approveApplication(prisma, reviewer, {
      reference: resubmitted.publicId,
      publicNote: 'Welcome in.',
    });

    const approved = await prisma.applicationSubmission.findUniqueOrThrow({
      where: { id: draft.id },
    });
    expect(approved.status).toBe('APPROVED');
    expect(approved.decidedAt).not.toBeNull();

    // The access the approval promised was granted in the same transaction.
    const whitelist = await prisma.whitelist.findUnique({ where: { userId: applicant.id } });
    expect(whitelist?.state).toBe('APPROVED');

    const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: applicant.id } });
    expect(refreshed.whitelistState).toBe('APPROVED');

    // --- The trail ---------------------------------------------------------
    expect(await eventTypes(draft.id)).toEqual([
      'CREATED',
      'SUBMITTED',
      'CHANGES_REQUESTED',
      'RESUBMITTED',
      'APPROVED',
    ]);

    expect(await auditActions(draft.id)).toEqual([
      'application.submitted',
      'application.changes_requested',
      'application.resubmitted',
      'application.approved',
    ]);

    // The applicant's copy of their own answers reflects the edit, not the
    // version they first submitted. This is the property autosave exists for:
    // thirty minutes of writing must still be there afterwards.
    const view = await getSubmissionView(prisma, applicantActor, draft.id);
    const stored = Object.values(view.answers)
      .map((value) => value?.textValue ?? '')
      .join(' ');
    expect(stored).toContain('considerably more detail');
    expect(view.progress.ratio).toBe(1);
  });

  it('records a rejection with its reason and tells the applicant', async () => {
    const template = await createTemplate();
    const { user: applicant, actor: applicantActor } = await createActor();
    const { actor: reviewer } = await createActor({ roleKeys: ['reviewer'] });

    const draft = await startApplication(prisma, applicantActor, template.slug);
    await autosave(prisma, applicantActor, {
      submissionId: draft.id,
      revision: 0,
      answers: await fillRequiredAnswers(prisma, draft.id),
    });
    await submitApplication(prisma, applicantActor, draft.id);

    await rejectApplication(prisma, reviewer, {
      reference: draft.publicId,
      publicNote: 'Application does not meet the standard we are looking for.',
    });

    const rejected = await prisma.applicationSubmission.findUniqueOrThrow({
      where: { id: draft.id },
    });
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.decisionNote).toContain('does not meet the standard');

    const review = await prisma.applicationReview.findFirstOrThrow({
      where: { submissionId: draft.id },
    });
    expect(review.decision).toBe('REJECTED');

    const notifications = await prisma.notification.count({ where: { userId: applicant.id } });
    expect(notifications).toBeGreaterThan(0);

    // A rejection grants nothing.
    const whitelist = await prisma.whitelist.findUnique({ where: { userId: applicant.id } });
    expect(whitelist).toBeNull();
  });

  it('refuses review actions from an account without the capability', async () => {
    const template = await createTemplate();
    const { actor: applicantActor } = await createActor();
    // Support staff: real staff, real capabilities, none of them application ones.
    const { actor: support } = await createActor({ roleKeys: ['support'] });

    const draft = await startApplication(prisma, applicantActor, template.slug);
    await autosave(prisma, applicantActor, {
      submissionId: draft.id,
      revision: 0,
      answers: await fillRequiredAnswers(prisma, draft.id),
    });
    await submitApplication(prisma, applicantActor, draft.id);

    await expect(
      approveApplication(prisma, support, { reference: draft.publicId }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const unchanged = await prisma.applicationSubmission.findUniqueOrThrow({
      where: { id: draft.id },
    });
    expect(unchanged.status).toBe('SUBMITTED');
  });

  it('refuses to let one applicant read or edit another applicant’s submission', async () => {
    const template = await createTemplate();
    const { actor: owner } = await createActor();
    const stranger = await createUser();
    const strangerActor = await actorFor(stranger);

    const draft = await startApplication(prisma, owner, template.slug);

    await expect(
      autosave(prisma, strangerActor, { submissionId: draft.id, revision: 0, answers: [] }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    await expect(getSubmissionView(prisma, strangerActor, draft.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('refuses edits once the submission has left the applicant’s hands', async () => {
    const template = await createTemplate();
    const { actor: applicantActor } = await createActor();

    const draft = await startApplication(prisma, applicantActor, template.slug);
    const answers = await fillRequiredAnswers(prisma, draft.id);
    const saved = await autosave(prisma, applicantActor, {
      submissionId: draft.id,
      revision: 0,
      answers,
    });
    await submitApplication(prisma, applicantActor, draft.id);

    await expect(
      autosave(prisma, applicantActor, {
        submissionId: draft.id,
        revision: saved.revision,
        answers,
      }),
    ).rejects.toThrow(/no longer be edited|Cannot edit/i);
  });

  it('refuses a submission that is missing a required answer', async () => {
    const template = await createTemplate();
    const { actor: applicantActor } = await createActor();

    const draft = await startApplication(prisma, applicantActor, template.slug);
    // Deliberately nothing saved.
    await expect(submitApplication(prisma, applicantActor, draft.id)).rejects.toThrow();

    const unchanged = await prisma.applicationSubmission.findUniqueOrThrow({
      where: { id: draft.id },
    });
    expect(unchanged.status).toBe('DRAFT');
  });

  it('lets an applicant withdraw, and does not resurrect the draft afterwards', async () => {
    const template = await createTemplate();
    const { actor: applicantActor } = await createActor();

    const draft = await startApplication(prisma, applicantActor, template.slug);
    await autosave(prisma, applicantActor, {
      submissionId: draft.id,
      revision: 0,
      answers: await fillRequiredAnswers(prisma, draft.id),
    });
    await submitApplication(prisma, applicantActor, draft.id);

    const withdrawn = await withdrawApplication(prisma, applicantActor, draft.id);
    expect(withdrawn.status).toBe('WITHDRAWN');

    // Starting again opens a new submission, because the old one is terminal.
    const fresh = await startApplication(prisma, applicantActor, template.slug);
    expect(fresh.id).not.toBe(draft.id);
  });
});
