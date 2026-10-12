import { prisma } from '@xenon/database';
import { requireUser } from '@xenon/permissions';

import { apiJson, runApi } from '~/server/api';
import { currentActor } from '~/server/context';

/**
 * GET /api/v1/me
 *
 * The signed-in player's account summary. Linked game identities are reported
 * as kinds and counts only: identifier values are never sent to a browser.
 */
export async function GET(): Promise<Response> {
  return runApi(async () => {
    const userId = requireUser(await currentActor());

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        publicId: true,
        displayName: true,
        status: true,
        whitelistState: true,
        onboardingStep: true,
        discordAccount: { select: { discordId: true, username: true } },
        gameIdentities: { where: { unlinkedAt: null }, select: { kind: true } },
      },
    });

    const counts = new Map<string, number>();
    for (const { kind } of user.gameIdentities) counts.set(kind, (counts.get(kind) ?? 0) + 1);

    return apiJson({
      publicId: user.publicId,
      displayName: user.displayName,
      discord:
        user.discordAccount === null
          ? null
          : { id: user.discordAccount.discordId, username: user.discordAccount.username },
      status: user.status,
      whitelistState: user.whitelistState,
      onboardingStep: user.onboardingStep,
      identities: {
        total: user.gameIdentities.length,
        kinds: [...counts].map(([kind, count]) => ({ kind, count })),
      },
    });
  });
}
