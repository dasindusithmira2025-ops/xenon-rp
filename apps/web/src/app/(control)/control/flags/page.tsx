import { prisma } from '@xenon/database';
import { allFeatureFlags } from '@xenon/domain';
import { EmptyState, Panel } from '@xenon/ui';

import { ControlPage } from '~/components/control/control-page';
import { FeatureFlagEditor } from '~/components/control/feature-flag-editor';
import { requireCapability } from '~/server/context';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Feature flags' };

/**
 * /control/system/flags
 *
 * Rollout is deterministic per user rather than random per call, so a player
 * who sees a feature on one page sees it on the next. "It appears sometimes"
 * is an unactionable bug report.
 */
export default async function FlagsPage(): Promise<React.ReactElement> {
  await requireCapability('system.manage');

  const [flags, roles] = await Promise.all([
    allFeatureFlags(prisma),
    prisma.role.findMany({ select: { key: true, name: true }, orderBy: { priority: 'desc' } }),
  ]);

  return (
    <ControlPage
      title="Feature flags"
      lead="Turn parts of the platform on for a subset of players before everyone."
    >
      <FeatureFlagEditor
        roles={roles}
        flags={flags.map((flag) => ({
          key: flag.key,
          description: flag.description,
          enabled: flag.enabled,
          rollout: flag.rollout,
          forceForRoleKeys: flag.forceForRoleKeys,
          updatedAt: flag.updatedAt.toISOString(),
        }))}
      />

      {flags.length === 0 ? (
        <EmptyState
          title="No flags defined"
          description="Create one above. Flags are read by name from application code, so the key has to match what the code checks."
        />
      ) : null}

      <Panel tone="ghost" pad="md">
        <p className="text-[0.6875rem] leading-relaxed text-ink-muted">
          A flag that no code reads does nothing. Roles listed under &ldquo;always on&rdquo; see the
          feature regardless of the rollout percentage, which is how staff test something before it
          reaches players.
        </p>
      </Panel>
    </ControlPage>
  );
}
