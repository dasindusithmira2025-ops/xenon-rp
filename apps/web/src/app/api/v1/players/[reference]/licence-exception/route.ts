import { z } from 'zod';

import { prisma } from '@xenon/database';
import { grantLicenceException } from '@xenon/fivem';
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
 * POST /api/v1/players/:reference/licence-exception
 *
 * The documented exception for a player whose FiveM client cannot report a
 * Cfx.re identifier: staff (`players.manage`) bind the player's Rockstar
 * licence to their Xenon account with a written reason. Audited; admits in
 * both admission modes. Never self-service.
 */
const exceptionInput = z.object({
  licence: z.string().trim().min(40).max(60),
  reason: z.string().trim().min(10).max(500),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ reference: string }> },
): Promise<Response> {
  return runApi(async () => {
    assertSameOrigin(request);
    const actor = await currentActor();
    const userId = requireUser(actor);
    await enforceApiMutationLimit(userId);

    const { reference } = await context.params;
    const input = parseInput(exceptionInput, await readJsonBody(request));
    const identity = await grantLicenceException(prisma, actor, {
      userPublicId: reference.trim().toUpperCase(),
      licence: input.licence,
      reason: input.reason,
    });
    return apiJson(
      { ok: true, identity: { kind: identity.kind, linkedVia: identity.linkedVia } },
      201,
    );
  });
}
