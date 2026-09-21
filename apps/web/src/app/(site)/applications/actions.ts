'use server';

import { startApplication } from '@xenon/applications';
import { prisma } from '@xenon/database';
import { startApplicationInput } from '@xenon/validation';

import { type ActionResult, parseInput, runAction } from '~/server/action';
import { requireSignedIn } from '~/server/context';

/**
 * Begin an application.
 *
 * The service does the real work - eligibility, rate limiting, the existing
 * draft check and the public identifier - so this is only the transport: parse,
 * resolve the actor, call, translate the result.
 */
export async function startApplicationAction(
  templateSlug: string,
): Promise<ActionResult<{ publicId: string }>> {
  return runAction(async () => {
    const input = parseInput(startApplicationInput, { templateSlug });
    const actor = await requireSignedIn();

    const submission = await startApplication(prisma, actor, input.templateSlug);
    return { publicId: submission.publicId };
  });
}
