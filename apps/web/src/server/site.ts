import 'server-only';

import { cache } from 'react';

import { isStaff } from '@xenon/auth';
import { prisma } from '@xenon/database';
import { allSettings, currentRuleSet, statusBoard } from '@xenon/domain';

import { currentActor } from './context';

import type { HeaderViewer } from '~/components/site/site-header';

/**
 * Data the public shell needs on every page.
 *
 * Gathered once per render and shared by the header and the footer. Each piece
 * is independently cached or cheap: the status board is a Redis read, the
 * settings map is a sixty-second cache, and the ruleset is one indexed row.
 */

export interface SiteChrome {
  readonly viewer: HeaderViewer | null;
  readonly serverState: 'ONLINE' | 'OFFLINE' | 'DEGRADED' | 'UNKNOWN';
  readonly playerCount: number | null;
  readonly discordInvite: string | null;
  readonly socials: readonly { label: string; href: string }[];
  readonly ruleVersion: number | null;
  readonly banner: string | null;
}

export const getSiteChrome = cache(async (): Promise<SiteChrome> => {
  const [actor, board, settings, ruleSet] = await Promise.all([
    currentActor(),
    statusBoard(prisma),
    allSettings(prisma),
    currentRuleSet(prisma),
  ]);

  let viewer: HeaderViewer | null = null;
  if (actor.userId !== null) {
    const user = await prisma.user.findUnique({
      where: { id: actor.userId },
      select: { displayName: true, publicId: true, avatarUrl: true },
    });
    viewer = {
      displayName: user?.displayName ?? null,
      publicId: user?.publicId ?? null,
      avatarUrl: user?.avatarUrl ?? null,
      isStaff: isStaff(actor),
    };
  }

  // Only configured socials are surfaced. An empty setting means the community
  // does not have that channel, not that we should link to a guess.
  const socials: { label: string; href: string }[] = [];
  for (const [label, key] of [
    ['YouTube', 'community.youtube'],
    ['TikTok', 'community.tiktok'],
    ['Instagram', 'community.instagram'],
  ] as const) {
    const href = settings[key];
    if (href !== undefined && href.length > 0) socials.push({ label, href });
  }

  const invite = settings['community.discordInvite'];

  return {
    viewer,
    serverState: board.aggregate,
    playerCount: board.totalPlayers,
    discordInvite: invite !== undefined && invite.length > 0 ? invite : null,
    socials,
    ruleVersion: ruleSet?.version ?? null,
    banner:
      settings['site.maintenanceMessage'] !== undefined &&
      settings['site.maintenanceMessage'].length > 0
        ? settings['site.maintenanceMessage']
        : null,
  };
});
