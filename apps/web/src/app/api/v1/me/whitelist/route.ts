import { statusLabels } from '@xenon/applications';
import { prisma } from '@xenon/database';
import { requireUser } from '@xenon/permissions';

import { apiJson, runApi } from '~/server/api';
import { currentActor } from '~/server/context';

/**
 * GET /api/v1/me/whitelist
 *
 * Whitelist state and the player's most recent whitelist application. Staff
 * notes are never part of this response.
 */
export async function GET(): Promise<Response> {
  return runApi(async () => {
    const userId = requireUser(await currentActor());

    const [user, application] = await Promise.all([
      prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { whitelistState: true, whitelist: { select: { reason: true } } },
      }),
      prisma.applicationSubmission.findFirst({
        where: { applicantId: userId, template: { grantsWhitelist: true } },
        orderBy: { updatedAt: 'desc' },
        select: { publicId: true, status: true },
      }),
    ]);

    return apiJson({
      state: user.whitelistState,
      reason: user.whitelist?.reason ?? null,
      application:
        application === null
          ? null
          : {
              reference: application.publicId,
              status: application.status,
              label: statusLabels[application.status],
            },
    });
  });
}
