import { ConflictError, NotFoundError } from '@xenon/core';
import {
  type Db,
  type Rule,
  type RuleCategory,
  type RuleSet,
  type RuleSeverity,
  transaction,
} from '@xenon/database';
import { cacheDelete, cached } from '@xenon/jobs';
import { type Actor, requirePermission } from '@xenon/permissions';
import type { RuleInput } from '@xenon/validation';

import { recordAudit } from './audit';
import { hashIp } from './hashing';
import { refreshOnboardingStep } from './users';

/**
 * The rulebook.
 *
 * Rules are versioned twice over. Each edit writes an immutable `RuleRevision`,
 * and publishing freezes the current revisions into a numbered `RuleSet`.
 * Acceptance points at a ruleset, so "which rules did this player agree to" has
 * an exact answer years later - which is the entire reason an appeal can be
 * decided fairly.
 */

const RULES_CACHE_KEY = 'rules:published';
const RULES_CACHE_TTL = 300;

/** Invalidate the published view after an out-of-band official-source import. */
export async function invalidatePublishedRulebookCache(): Promise<void> {
  await cacheDelete(RULES_CACHE_KEY);
}

export interface PublicRule {
  readonly id: string;
  readonly code: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly examples: string | null;
  readonly severity: RuleSeverity | null;
  readonly aliases: readonly string[];
  readonly updatedAt: string;
  readonly sourceRoot: string | null;
  readonly sourceUrl: string | null;
  readonly sourcePath: string | null;
  readonly sourceOrder: number | null;
  readonly contentHash: string | null;
  readonly sourceRetrievedAt: string | null;
}

export interface PublicRuleCategory {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly sourceRoot: string | null;
  readonly sourceUrl: string | null;
  readonly sourcePath: string | null;
  readonly sourceContentHash: string | null;
  readonly sourceRetrievedAt: string | null;
  readonly rules: readonly PublicRule[];
}

export interface PublishedRulebook {
  readonly categories: readonly PublicRuleCategory[];
  readonly version: number | null;
  readonly publishedAt: string | null;
  readonly sourceRoot: string | null;
  readonly contentHash: string | null;
  readonly sourceRetrievedAt: string | null;
  readonly ruleCount: number;
}

/**
 * The published rulebook, cached.
 *
 * Every visitor to /rules reads this, and it changes a handful of times a year,
 * so a five-minute cache removes almost all of the query load. The cache is
 * invalidated explicitly on publish rather than relying on the TTL.
 */
export async function publishedRulebook(db: Db): Promise<PublishedRulebook> {
  return cached(RULES_CACHE_KEY, RULES_CACHE_TTL, async () => {
    const [categories, current] = await Promise.all([
      db.ruleCategory.findMany({
        orderBy: { sortOrder: 'asc' },
        include: {
          rules: {
            where: { status: 'PUBLISHED' },
            orderBy: { sortOrder: 'asc' },
          },
        },
      }),
      db.ruleSet.findFirst({ where: { isCurrent: true } }),
    ]);

    const mapped = categories
      .map((category) => ({
        id: category.id,
        slug: category.slug,
        name: category.name,
        description: category.description,
        sourceRoot: category.sourceRoot,
        sourceUrl: category.sourceUrl,
        sourcePath: category.sourcePath,
        sourceContentHash: category.sourceContentHash,
        sourceRetrievedAt: category.sourceRetrievedAt?.toISOString() ?? null,
        rules: category.rules.map((rule): PublicRule => ({
          id: rule.id,
          code: rule.code,
          slug: rule.slug,
          title: rule.title,
          description: rule.description,
          examples: rule.examples,
          severity: rule.severity,
          aliases: rule.aliases,
          updatedAt: rule.updatedAt.toISOString(),
          sourceRoot: rule.sourceRoot,
          sourceUrl: rule.sourceUrl,
          sourcePath: rule.sourcePath,
          sourceOrder: rule.sourceOrder,
          contentHash: rule.sourceContentHash,
          sourceRetrievedAt: rule.sourceRetrievedAt?.toISOString() ?? null,
        })),
      }))
      // An empty category is a staging artefact, not something a player needs
      // to scroll past.
      .filter((category) => category.rules.length > 0);

    return {
      categories: mapped,
      version: current?.version ?? null,
      publishedAt: current?.publishedAt.toISOString() ?? null,
      sourceRoot: current?.sourceRoot ?? null,
      contentHash: current?.sourceContentHash ?? null,
      sourceRetrievedAt: current?.sourceRetrievedAt?.toISOString() ?? null,
      ruleCount: mapped.reduce((total, category) => total + category.rules.length, 0),
    };
  });
}

/**
 * Search the published rulebook.
 *
 * Runs over the cached structure rather than hitting Postgres per keystroke.
 * Aliases are weighted highest because the community searches "RDM", not
 * "Random deathmatch is prohibited within...".
 */
export function searchRulebook(
  rulebook: PublishedRulebook,
  query: string,
): readonly (PublicRule & { categoryName: string; score: number })[] {
  const needle = normalizeRuleSearchText(query.trim());
  if (needle.length === 0) return [];

  const results: (PublicRule & { categoryName: string; score: number })[] = [];

  for (const category of rulebook.categories) {
    for (const rule of category.rules) {
      let score = 0;
      if (rule.aliases.some((alias) => normalizeRuleSearchText(alias) === needle)) score += 100;
      if (normalizeRuleSearchText(rule.code) === needle) score += 90;
      if (rule.aliases.some((alias) => normalizeRuleSearchText(alias).includes(needle)))
        score += 40;
      if (normalizeRuleSearchText(rule.title).includes(needle)) score += 30;
      if (normalizeRuleSearchText(rule.code).includes(needle)) score += 20;
      if (normalizeRuleSearchText(rule.description).includes(needle)) score += 10;

      if (score > 0) results.push({ ...rule, categoryName: category.name, score });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 40);
}

/** Unicode canonical equivalence is used for matching; stored rule text is untouched. */
export function normalizeRuleSearchText(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase();
}

/** Create or update a rule, writing an immutable revision for the new wording. */
export async function upsertRule(
  db: Db,
  actor: Actor,
  input: RuleInput,
  ruleId?: string,
): Promise<Rule> {
  requirePermission(actor, 'rules.edit');

  const data = {
    categoryId: input.categoryId,
    code: input.code,
    slug: input.slug,
    title: input.title,
    description: input.description,
    examples: input.examples ?? null,
    severity: input.severity,
    aliases: input.aliases,
    status: input.status,
    sortOrder: input.sortOrder,
    ...(input.status === 'PUBLISHED' ? { publishedAt: new Date() } : {}),
  };

  const rule =
    ruleId === undefined
      ? await db.rule.create({ data })
      : await db.rule.update({ where: { id: ruleId }, data });

  const latest = await db.ruleRevision.findFirst({
    where: { ruleId: rule.id },
    orderBy: { version: 'desc' },
    select: { version: true },
  });

  await db.ruleRevision.create({
    data: {
      ruleId: rule.id,
      version: (latest?.version ?? 0) + 1,
      title: rule.title,
      description: rule.description,
      examples: rule.examples,
      severity: rule.severity,
      editedBy: actor.userId,
      changeNote: input.changeNote ?? null,
      contentHash: null,
    },
  });

  await recordAudit(db, actor, {
    action: ruleId === undefined ? 'rule.created' : 'rule.updated',
    entityType: 'rule',
    entityId: rule.id,
    entityLabel: rule.code,
    after: { title: rule.title, severity: rule.severity, status: rule.status },
  });

  await cacheDelete(RULES_CACHE_KEY);
  return rule;
}

export async function deleteRule(db: Db, actor: Actor, ruleId: string): Promise<void> {
  requirePermission(actor, 'rules.edit');

  const rule = await db.rule.findUnique({ where: { id: ruleId } });
  if (rule === null) throw new NotFoundError('Rule', ruleId);

  await db.rule.delete({ where: { id: ruleId } });
  await recordAudit(db, actor, {
    action: 'rule.deleted',
    entityType: 'rule',
    entityId: ruleId,
    entityLabel: rule.code,
    before: { title: rule.title, code: rule.code },
  });
  await cacheDelete(RULES_CACHE_KEY);
}

export async function upsertRuleCategory(
  db: Db,
  actor: Actor,
  input: { slug: string; name: string; description?: string | undefined; sortOrder: number },
  categoryId?: string,
): Promise<RuleCategory> {
  requirePermission(actor, 'rules.edit');

  const data = {
    slug: input.slug,
    name: input.name,
    description: input.description ?? null,
    sortOrder: input.sortOrder,
  };

  const category =
    categoryId === undefined
      ? await db.ruleCategory.create({ data })
      : await db.ruleCategory.update({ where: { id: categoryId }, data });

  await cacheDelete(RULES_CACHE_KEY);
  return category;
}

/**
 * Freeze the current published rules into a new numbered ruleset.
 *
 * Every player is asked to accept again after a publish, so this is a
 * deliberate, audited act rather than a side effect of editing a typo.
 */
export async function publishRuleSet(db: Db, actor: Actor, note: string | null): Promise<RuleSet> {
  requirePermission(actor, 'rules.publish');

  const published = await db.rule.findMany({
    where: { status: 'PUBLISHED' },
    select: { id: true },
  });
  if (published.length === 0) {
    throw new ConflictError('No published rules', 'Publish at least one rule first.');
  }

  const revisionIds: string[] = [];
  for (const rule of published) {
    const revision = await db.ruleRevision.findFirst({
      where: { ruleId: rule.id },
      orderBy: { version: 'desc' },
      select: { id: true },
    });
    if (revision !== null) revisionIds.push(revision.id);
  }

  const latest = await db.ruleSet.findFirst({
    orderBy: { version: 'desc' },
    select: { version: true },
  });

  const ruleSet = await transaction(db, async (tx) => {
    // Exactly one ruleset is current. Retiring the old one and creating the new
    // one in a single transaction means there is never a moment with zero or
    // two, which the acceptance check would read as "nothing to accept".
    await tx.ruleSet.updateMany({
      where: { isCurrent: true },
      data: { isCurrent: false, retiredAt: new Date() },
    });

    return tx.ruleSet.create({
      data: {
        version: (latest?.version ?? 0) + 1,
        revisionIds,
        publishedBy: actor.userId,
        note,
        isCurrent: true,
      },
    });
  });

  await recordAudit(db, actor, {
    action: 'ruleset.published',
    entityType: 'ruleset',
    entityId: ruleSet.id,
    entityLabel: `v${String(ruleSet.version)}`,
    after: { version: ruleSet.version, ruleCount: revisionIds.length },
    metadata: note === null ? undefined : { note },
  });

  await cacheDelete(RULES_CACHE_KEY);
  return ruleSet;
}

/** The ruleset players are currently asked to accept, if there is one. */
export async function currentRuleSet(db: Db): Promise<RuleSet | null> {
  return db.ruleSet.findFirst({ where: { isCurrent: true } });
}

/**
 * Record a player's acceptance.
 *
 * Stores the ruleset id, not a boolean, plus a hashed address and the user
 * agent. `acceptedRules = true` would be worthless the first time a player
 * argued that a rule did not exist when they joined.
 */
export async function acceptRules(
  db: Db,
  actor: Actor,
  userId: string,
  ruleSetId: string,
  context: { ip?: string | null; userAgent?: string | null } = {},
): Promise<void> {
  const ruleSet = await db.ruleSet.findUnique({ where: { id: ruleSetId } });
  if (ruleSet === null) throw new NotFoundError('RuleSet', ruleSetId);
  if (!ruleSet.isCurrent) {
    throw new ConflictError(
      'Attempted to accept a retired ruleset',
      'The rules have changed since this page loaded. Reload and read the current version.',
    );
  }

  await db.ruleAcceptance.upsert({
    where: { userId_ruleSetId: { userId, ruleSetId } },
    create: {
      userId,
      ruleSetId,
      ruleSetHash: ruleSet.sourceContentHash,
      ipHash: hashIp(context.ip),
      userAgent: context.userAgent?.slice(0, 300) ?? null,
    },
    update: {},
  });

  await recordAudit(db, actor, {
    action: 'rules.accepted',
    entityType: 'user',
    entityId: userId,
    entityLabel: actor.publicId,
    after: { ruleSetVersion: ruleSet.version },
  });

  await refreshOnboardingStep(db, userId);
}

/** Whether a user has accepted the ruleset currently in force. */
export async function hasAcceptedCurrentRules(db: Db, userId: string): Promise<boolean> {
  const current = await currentRuleSet(db);
  if (current === null) return true;

  const acceptance = await db.ruleAcceptance.findUnique({
    where: { userId_ruleSetId: { userId, ruleSetId: current.id } },
    select: { id: true },
  });

  return acceptance !== null;
}

/** Full rulebook including drafts. Staff only. */
export async function staffRulebook(db: Db) {
  return db.ruleCategory.findMany({
    orderBy: { sortOrder: 'asc' },
    include: { rules: { orderBy: { sortOrder: 'asc' } } },
  });
}
