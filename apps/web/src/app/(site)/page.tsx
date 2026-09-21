import { siteMeta } from '@xenon/config';
import { prisma } from '@xenon/database';
import {
  allSettings,
  publishedArticles,
  publishedDepartments,
  publishedRulebook,
  statusBoard,
} from '@xenon/domain';

import type { Metadata } from 'next';

import {
  type CityStatistic,
  DepartmentsStrip,
  LatestNews,
  RealStatistics,
} from '~/components/home/data-sections';
import { Hero } from '~/components/home/hero';
import {
  ChooseYourStory,
  CitySystems,
  CityShowcase,
  CommunitySection,
  LiveCity,
  ThisIsXenon,
  Underworld,
  WhitelistCta,
} from '~/components/home/sections';
import { currentActor } from '~/server/context';

export const metadata: Metadata = {
  title: siteMeta.title,
  description: siteMeta.description,
  alternates: { canonical: '/' },
};

/**
 * Homepage.
 *
 * Revalidated rather than dynamic: nothing here is per-user except the two call
 * to action labels, and the live status strip reads from a Redis-cached board
 * that the poller refreshes independently. A minute of staleness on the rest is
 * invisible; rendering this page from scratch for every visitor is not.
 */
export const revalidate = 60;

async function cityStatistics(): Promise<readonly CityStatistic[]> {
  const [whitelisted, characters, departments, approved, rulebook] = await Promise.all([
    prisma.user.count({ where: { whitelistState: 'APPROVED', deletedAt: null } }),
    prisma.character.count({ where: { status: 'ACTIVE' } }),
    prisma.department.count({ where: { status: 'PUBLISHED' } }),
    prisma.applicationSubmission.count({ where: { status: 'APPROVED' } }),
    publishedRulebook(prisma),
  ]);

  return [
    { label: 'Whitelisted', value: whitelisted, caption: 'players cleared to connect' },
    { label: 'Characters', value: characters, caption: 'active lives in the city' },
    { label: 'Departments', value: departments, caption: 'player-run organisations' },
    { label: 'Applications', value: approved, caption: 'approved to date' },
    { label: 'Rules', value: rulebook.ruleCount, caption: 'published and versioned' },
  ].slice(0, 4);
}

export default async function HomePage(): Promise<React.ReactElement> {
  const [actor, board, settings, departments, articles, statistics] = await Promise.all([
    currentActor(),
    statusBoard(prisma),
    allSettings(prisma),
    publishedDepartments(prisma),
    publishedArticles(prisma, 5),
    cityStatistics(),
  ]);

  const primary = board.servers[0];
  const signedIn = actor.userId !== null;
  const discordInvite = settings['community.discordInvite'];
  const connectUrl = settings['community.connectUrl'];

  return (
    <>
      <Hero
        videoUrl={emptyToNull(settings['site.heroVideoUrl'])}
        posterUrl={emptyToNull(settings['site.heroPosterUrl'])}
        serverState={board.aggregate}
        playerCount={board.totalPlayers}
        signedIn={signedIn}
      />

      <LiveCity
        state={board.aggregate}
        playerCount={board.totalPlayers}
        maxPlayers={board.totalCapacity}
        nextRestart={primary?.nextRestartAt ?? null}
        connectUrl={emptyToNull(connectUrl) ?? primary?.connectUrl ?? null}
      />

      <ThisIsXenon />
      <ChooseYourStory />
      <CityShowcase />
      <DepartmentsStrip departments={departments} />
      <CitySystems />
      <Underworld />
      <CommunitySection discordInvite={emptyToNull(discordInvite)} />
      <LatestNews articles={articles} />
      <RealStatistics statistics={statistics} />
      <WhitelistCta signedIn={signedIn} />
    </>
  );
}

/** Settings default to an empty string; the components want an explicit null. */
function emptyToNull(value: string | undefined): string | null {
  return value !== undefined && value.length > 0 ? value : null;
}
