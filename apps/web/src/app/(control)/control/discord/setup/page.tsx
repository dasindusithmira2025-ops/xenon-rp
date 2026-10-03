import { serverEnv } from '@xenon/config/server';
import { prisma } from '@xenon/database';
import {
  BLUEPRINT_VERSION,
  blueprintFeatures,
  enforcementMode,
  loadOrganizationSpaces,
  parseDepartmentSpace,
  recentRuns,
} from '@xenon/discord/web';
import { Panel } from '@xenon/ui';

import { ControlPage } from '~/components/control/control-page';
import { type RunView, SetupConsole } from '~/components/control/discord-setup/setup-console';
import { requireCapability } from '~/server/context';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Discord server setup' };

/**
 * /control/discord/setup
 *
 * The Control Center face of the provisioning engine. It reads runs the bot
 * wrote and records the operator's intent; it never talks to Discord itself.
 */
export default async function DiscordSetupPage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string }>;
}): Promise<React.ReactElement> {
  const actor = await requireCapability('system.discord.bootstrap');
  const guildId = serverEnv.DISCORD_GUILD_ID;
  const { run: selectedId } = await searchParams;

  if (guildId === undefined) {
    return (
      <ControlPage title="Server setup" breadcrumb={{ href: '/control/discord', label: 'Discord' }}>
        <Panel tone="ghost" pad="lg" className="border-warning/30 bg-warning/5">
          <p className="text-sm text-warning">
            DISCORD_GUILD_ID is not configured. Point it at a development server first, then return
            here to plan.
          </p>
        </Panel>
      </ControlPage>
    );
  }

  const [runs, features, enforcement, departments, organizations, resources, guild] =
    await Promise.all([
      recentRuns(prisma, guildId, 25),
      blueprintFeatures(prisma),
      enforcementMode(prisma),
      prisma.department.findMany({
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true,
          slug: true,
          name: true,
          shortName: true,
          status: true,
          discordSpace: true,
        },
      }),
      loadOrganizationSpaces(prisma, guildId),
      prisma.discordManagedResource.groupBy({
        by: ['resourceType'],
        where: { guildId, managed: true, discordResourceId: { not: null } },
        _count: { _all: true },
      }),
      prisma.discordGuild.findUnique({ where: { guildId }, select: { name: true } }),
    ]);

  const toView = (run: (typeof runs)[number]): RunView => ({
    id: run.id,
    mode: run.mode,
    status: run.status,
    source: run.source,
    actorLabel: run.actorLabel,
    createdAt: run.createdAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    failure: run.failure,
    planned: (run.plannedChanges ?? null) as RunView['planned'],
    progress: (run.progress ?? null) as RunView['progress'],
    summary: (run.summary ?? null) as RunView['summary'],
    basedOnRunId: run.basedOnRunId,
  });

  const views = runs.map(toView);
  // The focused run drives the outcome banner; the plan shown is the focused
  // run's when it has one, otherwise the latest analysis - an apply stores no
  // plan of its own, and the page should not go blank after one.
  const focus =
    selectedId === undefined ? null : (views.find((run) => run.id === selectedId) ?? null);
  const selected =
    (focus?.planned == null ? undefined : focus) ??
    views.find(
      (run) =>
        run.planned !== null &&
        (run.mode === 'PLAN' || run.mode === 'STATUS' || run.mode === 'VALIDATE'),
    ) ??
    null;

  return (
    <SetupConsole
      guildId={guildId}
      guildName={guild?.name ?? null}
      blueprintVersion={BLUEPRINT_VERSION}
      runs={views}
      focus={focus}
      selected={selected}
      features={features}
      enforcement={enforcement}
      canDestroy={actor.permissions.has('system.discord.bootstrap.destructive')}
      managed={Object.fromEntries(resources.map((row) => [row.resourceType, row._count._all]))}
      departments={departments.map((department) => ({
        id: department.id,
        slug: department.slug,
        name: department.name,
        shortName: department.shortName,
        published: department.status === 'PUBLISHED',
        space: parseDepartmentSpace(department.discordSpace),
      }))}
      organizations={organizations}
    />
  );
}
