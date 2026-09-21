'use server';

import { revalidatePath } from 'next/cache';

import { submitApplication } from '@xenon/applications';
import { prisma } from '@xenon/database';
import { cuid } from '@xenon/validation';

import { type ActionResult, parseInput, runAction } from '~/server/action';
import { requireSignedIn } from '~/server/context';

/**
 * Submit an application.
 *
 * The service re-validates every stored answer, checks the state transition,
 * writes the timeline entry and the audit record, and enqueues the Discord
 * review card after the transaction commits. Nothing about that lives here.
 */
export async function submitApplicationAction(submissionId: string): Promise<ActionResult> {
  return runAction(async () => {
    const id = parseInput(cuid, submissionId);
    const actor = await requireSignedIn();

    const submission = await submitApplication(prisma, actor, id);

    revalidatePath('/portal/applications');
    revalidatePath(`/portal/applications/${submission.publicId}`);
    revalidatePath('/portal');
  });
}
