import { prisma } from '@xenon/database';
import { currentRuleSet, staffRulebook } from '@xenon/domain';
import { Badge, Panel } from '@xenon/ui';

import { ControlPage, MetricTile } from '~/components/control/control-page';
import { RuleEditor } from '~/components/control/rule-editor';
import { currentActor, requireCapability } from '~/server/context';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Rulebook' };

/**
 * /control/content/rules
 *
 * Rules are versioned twice: every edit writes an immutable revision, and
 * publishing freezes the current revisions into a numbered ruleset that players
 * are asked to accept. That is why publishing is a separate, audited act behind
 * its own capability rather than a side effect of fixing a typo.
 */
export default async function ControlRulesPage(): Promise<React.ReactElement> {
  await requireCapability('rules.edit');
  const actor = await currentActor();

  const [categories, ruleSet, acceptedCount, totalPlayers] = await Promise.all([
    staffRulebook(prisma),
    currentRuleSet(prisma),
    prisma.ruleAcceptance.count({ where: { ruleSet: { isCurrent: true } } }),
    prisma.user.count({ where: { deletedAt: null } }),
  ]);

  const published = categories.reduce(
    (total, category) =>
      total + category.rules.filter((rule) => rule.status === 'PUBLISHED').length,
    0,
  );
  const drafts = categories.reduce(
    (total, category) => total + category.rules.filter((rule) => rule.status === 'DRAFT').length,
    0,
  );

  return (
    <ControlPage
      title="Rulebook"
      lead="Edits write a revision. Publishing freezes the current revisions into a ruleset that players must accept."
      actions={
        <Badge tone={ruleSet === null ? 'warning' : 'success'}>
          {ruleSet === null ? 'Never published' : `Version ${String(ruleSet.version)}`}
        </Badge>
      }
    >
      <div className="grid gap-4 sm:grid-cols-4">
        <MetricTile label="Published rules" value={published} />
        <MetricTile label="Drafts" value={drafts} tone={drafts > 0 ? 'warn' : 'neutral'} />
        <MetricTile label="Categories" value={categories.length} />
        <MetricTile
          label="Accepted current"
          value={acceptedCount}
          hint={`of ${String(totalPlayers)} accounts`}
        />
      </div>

      <RuleEditor
        canPublish={actor.permissions.has('rules.publish')}
        officialMode={ruleSet?.sourceRoot !== undefined && ruleSet.sourceRoot !== null}
        currentVersion={ruleSet?.version ?? null}
        draftCount={drafts}
        categories={categories.map((category) => ({
          id: category.id,
          slug: category.slug,
          name: category.name,
          description: category.description,
          rules: category.rules.map((rule) => ({
            id: rule.id,
            code: rule.code,
            slug: rule.slug,
            title: rule.title,
            description: rule.description,
            examples: rule.examples,
            severity: rule.severity,
            aliases: rule.aliases,
            status: rule.status,
            sortOrder: rule.sortOrder,
            sourcePath: rule.sourcePath,
            sourceContentHash: rule.sourceContentHash,
            isDevelopmentFixture: rule.isDevelopmentFixture,
          })),
        }))}
      />

      <Panel tone="ghost" pad="md">
        <p className="text-[0.6875rem] leading-relaxed text-ink-muted">
          Aliases are what the community actually types. Adding &ldquo;RDM&rdquo; to a rule whose
          title does not contain those letters is what makes the public search find it.
        </p>
      </Panel>
    </ControlPage>
  );
}
