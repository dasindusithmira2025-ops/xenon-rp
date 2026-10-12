import { z } from 'zod';

import {
  approveApplication,
  rejectApplication,
  requestChanges,
  requestInterview,
} from '@xenon/applications';
import { prisma } from '@xenon/database';
import { requireUser } from '@xenon/permissions';

import { parseInput } from '~/server/action';
import {
  apiJson,
  assertSameOrigin,
  enforceApiMutationLimit,
  readJsonBody,
  runApi,
} from '~/server/api';
import { currentActor } from '~/server/context';

/**
 * POST /api/v1/applications/:reference/decision
 *
 * A staff decision on an application, as the signed-in actor. The review
 * services enforce the per-action capability and the state machine; this route
 * only authenticates, checks origin, rate limits and validates.
 */
const note = z.string().trim().max(2000);

const decisionInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('approve'),
    publicNote: note.optional(),
    staffNote: note.optional(),
  }),
  z.object({ action: z.literal('reject'), publicNote: note.min(1), staffNote: note.optional() }),
  z.object({ action: z.literal('changes'), publicNote: note.min(1), staffNote: note.optional() }),
  z.object({
    action: z.literal('interview'),
    publicNote: note.optional(),
    staffNote: note.optional(),
  }),
]);

const reference = z.string().trim().min(1).max(40);

export async function POST(
  request: Request,
  context: { params: Promise<{ reference: string }> },
): Promise<Response> {
  return runApi(async () => {
    assertSameOrigin(request);
    const actor = await currentActor();
    const userId = requireUser(actor);
    await enforceApiMutationLimit(userId);

    const { reference: rawReference } = await context.params;
    const input = parseInput(decisionInput, await readJsonBody(request));
    const base = {
      reference: parseInput(reference, rawReference),
      staffNote: input.staffNote ?? null,
    };

    const submission =
      input.action === 'approve'
        ? await approveApplication(prisma, actor, { ...base, publicNote: input.publicNote ?? null })
        : input.action === 'reject'
          ? await rejectApplication(prisma, actor, { ...base, publicNote: input.publicNote })
          : input.action === 'changes'
            ? await requestChanges(prisma, actor, { ...base, publicNote: input.publicNote })
            : await requestInterview(prisma, actor, {
                ...base,
                publicNote: input.publicNote ?? null,
              });

    return apiJson({ ok: true, reference: submission.publicId, status: submission.status });
  });
}
