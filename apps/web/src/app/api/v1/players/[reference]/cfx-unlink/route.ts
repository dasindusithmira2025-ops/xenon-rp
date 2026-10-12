import { z } from 'zod';

import { prisma } from '@xenon/database';
import { staffUnlinkCfx } from '@xenon/fivem';
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
 * POST /api/v1/players/:reference/cfx-unlink
 *
 * Staff (`players.manage`) remove a disputed Cfx.re link with a written
 * reason so the rightful owner can verify the account again. Audited.
 */
const unlinkInput = z.object({ reason: z.string().trim().min(10).max(500) });

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
    const input = parseInput(unlinkInput, await readJsonBody(request));
    await staffUnlinkCfx(prisma, actor, {
      userPublicId: reference.trim().toUpperCase(),
      reason: input.reason,
    });
    return apiJson({ ok: true });
  });
}
