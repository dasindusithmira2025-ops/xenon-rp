'use server';

import { revalidatePath } from 'next/cache';

import {
  addComment,
  approveApplication,
  assignReviewer,
  claimApplication,
  completeInterview,
  rejectApplication,
  requestChanges,
  requestInterview,
  scheduleInterview,
} from '@xenon/applications';
import { prisma } from '@xenon/database';
import {
  applicationCommentInput,
  assignReviewerInput,
  publicId as publicIdSchema,
  rejectApplicationInput,
  requestChangesInput,
  reviewDecisionInput,
  scheduleInterviewInput,
} from '@xenon/validation';

import { type ActionResult, parseInput, runAction } from '~/server/action';
import { currentActor } from '~/server/context';

/**
 * Review actions.
 *
 * Every one is a thin transport over the shared service. The capability check,
 * the state machine, the audit entry, the applicant notification and the queued
 * Discord and FiveM side effects all live in `@xenon/applications`, which is
 * why clicking Approve on the website and clicking Approve on a Discord embed
 * produce identical results.
 */

function refresh(reference: string): void {
  revalidatePath('/control/applications');
  revalidatePath(`/control/applications/${reference}`);
  revalidatePath('/control');
}

export async function claimAction(reference: string): Promise<ActionResult> {
  return runAction(async () => {
    const id = parseInput(publicIdSchema, reference);
    const actor = await currentActor();

    await claimApplication(prisma, actor, id);
    refresh(id);
  });
}

export async function assignAction(
  reference: string,
  assigneeId: string | null,
): Promise<ActionResult> {
  return runAction(async () => {
    const input = parseInput(assignReviewerInput, { submissionId: reference, assigneeId });
    const actor = await currentActor();

    await assignReviewer(prisma, actor, reference, input.assigneeId);
    refresh(reference);
  });
}

export async function approveAction(
  reference: string,
  publicNote: string,
  staffNote: string,
): Promise<ActionResult> {
  return runAction(async () => {
    const input = parseInput(reviewDecisionInput, {
      submissionId: reference,
      publicNote,
      staffNote,
    });
    const actor = await currentActor();

    await approveApplication(prisma, actor, {
      reference,
      publicNote: input.publicNote ?? null,
      staffNote: input.staffNote ?? null,
    });
    refresh(reference);
  });
}

export async function rejectAction(
  reference: string,
  publicNote: string,
  staffNote: string,
): Promise<ActionResult> {
  return runAction(async () => {
    // The reason is mandatory here and optional on approval: a rejection the
    // applicant cannot understand becomes a support ticket.
    const input = parseInput(rejectApplicationInput, {
      submissionId: reference,
      publicNote,
      staffNote,
    });
    const actor = await currentActor();

    await rejectApplication(prisma, actor, {
      reference,
      publicNote: input.publicNote,
      staffNote: input.staffNote ?? null,
    });
    refresh(reference);
  });
}

export async function requestChangesAction(
  reference: string,
  publicNote: string,
  staffNote: string,
): Promise<ActionResult> {
  return runAction(async () => {
    const input = parseInput(requestChangesInput, {
      submissionId: reference,
      publicNote,
      staffNote,
    });
    const actor = await currentActor();

    await requestChanges(prisma, actor, {
      reference,
      publicNote: input.publicNote,
      staffNote: input.staffNote ?? null,
    });
    refresh(reference);
  });
}

export async function requestInterviewAction(
  reference: string,
  staffNote: string,
): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await currentActor();
    await requestInterview(prisma, actor, { reference, staffNote });
    refresh(reference);
  });
}

export async function scheduleInterviewAction(
  reference: string,
  scheduledFor: string,
  location: string,
): Promise<ActionResult> {
  return runAction(async () => {
    const input = parseInput(scheduleInterviewInput, {
      submissionId: reference,
      scheduledFor,
      location,
    });
    const actor = await currentActor();

    await scheduleInterview(prisma, actor, {
      reference,
      scheduledFor: input.scheduledFor,
      location: input.location ?? null,
    });
    refresh(reference);
  });
}

export async function completeInterviewAction(
  reference: string,
  outcome: 'PASSED' | 'FAILED' | 'INCONCLUSIVE',
  notes: string,
): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await currentActor();
    await completeInterview(prisma, actor, { reference, outcome, notes });
    refresh(reference);
  });
}

export async function commentAction(
  reference: string,
  body: string,
  visibility: 'INTERNAL' | 'APPLICANT',
): Promise<ActionResult> {
  return runAction(async () => {
    const input = parseInput(applicationCommentInput, {
      submissionId: reference,
      body,
      visibility,
    });
    const actor = await currentActor();

    await addComment(prisma, actor, {
      reference,
      body: input.body,
      visibility: input.visibility,
    });
    refresh(reference);
  });
}
