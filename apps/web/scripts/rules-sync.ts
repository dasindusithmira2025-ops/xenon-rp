import '@xenon/config/load-env';

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// This administrative CLI runs outside the web request/component boundary.
// eslint-disable-next-line no-restricted-imports -- standalone rulebook sync command
import { prisma } from '@xenon/database';
import {
  diffSourceText,
  extractSourcePage,
  invalidatePublishedRulebookCache,
  sourceSnapshotHash,
  type RuleSourceSnapshot,
  type SourceRulePage,
} from '@xenon/domain';
import { closeRedis } from '@xenon/jobs';

const SOURCE_ROOT = 'xenonrp://official-rulebook';
const CANDIDATE_FILE = fileURLToPath(
  new URL('../../../docs/rules/xenon-rulebook.md', import.meta.url),
);

interface ExistingRule {
  readonly id: string;
  readonly code: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly status: 'DRAFT' | 'PUBLISHED';
  readonly sortOrder: number;
  readonly sourceUrl: string | null;
  readonly sourcePath: string | null;
  readonly sourceOrder: number | null;
  readonly sourceContentHash: string | null;
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function slugForTitle(title: string): string {
  const slug = title
    .normalize('NFKD')
    .toLocaleLowerCase('en-US')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (slug.length === 0) throw new Error(`Cannot derive a source path from "${title}".`);
  return slug;
}

function pageFromMarkdown(title: string, content: string, sourceOrder: number): SourceRulePage {
  const sourcePath = sourceOrder === 0 ? '/' : `/${slugForTitle(title)}`;
  const rawMarkdown = `# ${title}\n\n${content}`;
  const extracted = extractSourcePage(rawMarkdown);
  return {
    sourceUrl: SOURCE_ROOT,
    sourcePath,
    sourceOrder,
    title: extracted.title,
    content: extracted.content,
    contentHash: extracted.contentHash,
    rawMarkdown,
  };
}

function sectionContent(markdown: string, start: number, end: number): string {
  return markdown
    .slice(start, end)
    .replace(/^(?:\r?\n)+/, '')
    .replace(/(?:\r?\n)+$/, '\n');
}

function validateSnapshot(snapshot: RuleSourceSnapshot): void {
  if (snapshot.schemaVersion !== 1 || snapshot.sourceRoot !== SOURCE_ROOT) {
    throw new Error('Authored rulebook schema or source URL is not supported.');
  }
  if (snapshot.pages.length < 2 || snapshot.pages[0]?.sourceOrder !== 0) {
    throw new Error('Authored rulebook must contain an index and at least one section.');
  }

  const paths = new Set<string>();
  for (const [order, page] of snapshot.pages.entries()) {
    const expectedPath = order === 0 ? '/' : `/${slugForTitle(page.title)}`;
    if (
      paths.has(page.sourcePath) ||
      page.sourcePath !== expectedPath ||
      page.sourceOrder !== order ||
      page.sourceUrl !== SOURCE_ROOT
    ) {
      throw new Error(`Invalid source path, URL, or order for ${page.title}.`);
    }
    paths.add(page.sourcePath);

    const extracted = extractSourcePage(page.rawMarkdown);
    if (
      extracted.title !== page.title ||
      extracted.content !== page.content ||
      extracted.contentHash !== page.contentHash
    ) {
      throw new Error(`Authored Markdown or content hash is inconsistent for ${page.title}.`);
    }
  }
  if (
    snapshot.sourceTitle !== snapshot.pages[0].title ||
    sourceSnapshotHash(snapshot.pages) !== snapshot.contentHash
  ) {
    throw new Error('Authored rulebook title or manifest hash is inconsistent.');
  }
}

async function readCandidate(): Promise<RuleSourceSnapshot> {
  const markdown = (await readFile(CANDIDATE_FILE, 'utf8')).replaceAll('\r\n', '\n');
  const headings = [...markdown.matchAll(/^(#{1,2}) (.+)$/gm)];
  const first = headings[0];
  if (first?.index !== 0 || first[1] !== '#') {
    throw new Error('Authored rulebook must begin with one H1 title.');
  }
  if (headings.slice(1).some((heading) => heading[1] !== '##')) {
    throw new Error('Authored rulebook may contain only one H1 followed by H2 sections.');
  }

  const pages = headings.map((heading, order) => {
    const headingEnd = heading.index + heading[0].length;
    const nextHeading = headings[order + 1];
    const contentEnd = nextHeading?.index ?? markdown.length;
    const title = heading[2] ?? '';
    const content = sectionContent(markdown, headingEnd, contentEnd);
    return pageFromMarkdown(title, content, order);
  });
  const firstPage = pages[0];
  if (firstPage === undefined) throw new Error('Authored rulebook title is missing.');

  const snapshot: RuleSourceSnapshot = {
    schemaVersion: 1,
    sourceRoot: SOURCE_ROOT,
    sourceTitle: firstPage.title,
    retrievedAt: new Date().toISOString(),
    contentHash: sourceSnapshotHash(pages),
    pages,
  };
  validateSnapshot(snapshot);
  return snapshot;
}

function diffPage(oldPage: { title: string; description: string }, page: SourceRulePage): string {
  return diffSourceText(
    `# ${oldPage.title}\n\n${oldPage.description}`,
    `# ${page.title}\n\n${page.content}`,
  );
}

async function plan(): Promise<void> {
  const snapshot = await readCandidate();

  const category = await prisma.ruleCategory.findUnique({
    where: { slug: 'xenonrp-official-rulebook' },
  });
  const [current, otherPublishedCount] = await Promise.all([
    prisma.ruleSet.findFirst({ where: { isCurrent: true } }),
    prisma.rule.count({
      where: {
        status: 'PUBLISHED',
        ...(category === null ? {} : { categoryId: { not: category.id } }),
      },
    }),
  ]);
  const rules =
    category === null
      ? []
      : await prisma.rule.findMany({
          where: { categoryId: category.id },
          select: {
            id: true,
            code: true,
            slug: true,
            title: true,
            description: true,
            status: true,
            sortOrder: true,
            sourceUrl: true,
            sourcePath: true,
            sourceOrder: true,
            sourceContentHash: true,
          },
        });
  const oldByPath = new Map(rules.map((rule) => [rule.sourcePath ?? '', rule as ExistingRule]));
  const unmatchedOld = new Set(rules.map((rule) => rule.id));
  const pageLines: string[] = [];

  for (const page of snapshot.pages) {
    if (page.sourceOrder === 0) {
      if (category === null) pageLines.push(`[NEW PAGE] / | ${page.title}`);
      else if (category.sourceContentHash !== page.contentHash) {
        pageLines.push(`[CHANGED PAGE] / | ${page.title}`);
        pageLines.push(
          diffSourceText(
            `# ${category.name}\n\n${category.description ?? ''}`,
            `# ${page.title}\n\n${page.content}`,
          ),
        );
      } else pageLines.push(`[UNCHANGED] / | ${page.title}`);
      continue;
    }

    const existing = oldByPath.get(page.sourcePath);
    if (existing !== undefined) {
      unmatchedOld.delete(existing.id);
      if (existing.sourceContentHash === page.contentHash) {
        if (existing.sourceOrder !== page.sourceOrder) {
          pageLines.push(
            `[MOVED] ${page.sourcePath} | ${page.title} | order ${String(existing.sourceOrder)} -> ${String(page.sourceOrder)}`,
          );
        } else pageLines.push(`[UNCHANGED] ${page.sourcePath} | ${page.title}`);
      } else {
        pageLines.push(`[CHANGED RULE] ${page.sourcePath} | ${page.title}`);
        pageLines.push(diffPage(existing, page));
      }
      continue;
    }

    const moved = rules.find(
      (candidate) =>
        unmatchedOld.has(candidate.id) && candidate.sourceContentHash === page.contentHash,
    );
    if (moved !== undefined) {
      unmatchedOld.delete(moved.id);
      pageLines.push(
        `[MOVED] ${moved.sourcePath ?? '(unknown)'} -> ${page.sourcePath} | ${page.title}`,
      );
    } else {
      pageLines.push(`[NEW PAGE] ${page.sourcePath} | ${page.title}`);
      pageLines.push(`[NEW RULE] ${page.sourcePath} | page-level source unit`);
    }
  }

  for (const removed of rules.filter((rule) => unmatchedOld.has(rule.id))) {
    pageLines.push(
      `[REMOVED FROM SOURCE] ${removed.sourcePath ?? removed.slug} | ${removed.title}`,
    );
  }

  log('Authored locally for XenonRP.');
  log(`Prepared: ${snapshot.retrievedAt}`);
  log(
    `Pages discovered: ${String(snapshot.pages.length)} (1 index, ${String(snapshot.pages.length - 1)} rule pages)`,
  );
  log(
    `Published Xenon ruleset: ${current?.version === undefined ? 'none' : `v${String(current.version)}`}`,
  );
  if (otherPublishedCount > 0) {
    log(`Published rules from other sources to retire on apply: ${String(otherPublishedCount)}`);
  }
  log(`Source content hash: ${snapshot.contentHash}`);
  log('--- PLAN (database unchanged) ---');
  for (const line of pageLines) log(line);
  log(`Authored rulebook: ${CANDIDATE_FILE}`);
}

function ruleSlug(page: SourceRulePage): string {
  return `xenonrp-${page.sourcePath.replace(/^\//, '')}`;
}

function ruleCode(page: SourceRulePage): string {
  return `source-${ruleSlug(page)}`;
}

async function apply(): Promise<void> {
  const snapshot = await readCandidate();
  const importedPages = snapshot.pages.filter((page) => page.sourceOrder !== 0);
  if (importedPages.length === 0) throw new Error('The authored rulebook contains no sections.');

  const category = await prisma.ruleCategory.findUnique({
    where: { slug: 'xenonrp-official-rulebook' },
    select: { id: true },
  });
  const existingRules =
    category === null
      ? []
      : await prisma.rule.findMany({
          where: { categoryId: category.id },
          select: {
            id: true,
            code: true,
            slug: true,
            title: true,
            description: true,
            status: true,
            sortOrder: true,
            sourcePath: true,
            sourceContentHash: true,
          },
        });
  const [foreignPublished, current] = await Promise.all([
    prisma.rule.count({
      where: {
        status: 'PUBLISHED',
        ...(category === null ? {} : { categoryId: { not: category.id } }),
      },
    }),
    prisma.ruleSet.findFirst({ where: { isCurrent: true } }),
  ]);
  const rowsByPath = new Map(existingRules.map((rule) => [rule.sourcePath ?? '', rule]));
  const pageStateMatches =
    existingRules.length === importedPages.length &&
    importedPages.every((page) => {
      const row = rowsByPath.get(page.sourcePath);
      return (
        row?.status === 'PUBLISHED' &&
        row.title === page.title &&
        row.description === page.content &&
        row.sourceContentHash === page.contentHash &&
        row.sortOrder === page.sourceOrder
      );
    });

  if (
    current?.sourceRoot === SOURCE_ROOT &&
    current.sourceContentHash === snapshot.contentHash &&
    pageStateMatches &&
    foreignPublished === 0 &&
    current.revisionIds.length === importedPages.length
  ) {
    log(
      `Already current: ruleset v${String(current.version)} (${snapshot.contentHash}). No database changes.`,
    );
    return;
  }

  const retrievedAt = new Date(snapshot.retrievedAt);
  const result = await prisma.$transaction(async (tx) => {
    const indexPage = snapshot.pages[0];
    if (indexPage === undefined) throw new Error('Authored rulebook index is missing.');
    const categoryData = {
      slug: 'xenonrp-official-rulebook',
      name: indexPage.title,
      description: indexPage.content || null,
      sortOrder: 0,
      sourceRoot: SOURCE_ROOT,
      sourceUrl: indexPage.sourceUrl,
      sourcePath: indexPage.sourcePath,
      sourcePageTitle: indexPage.title,
      sourceOrder: indexPage.sourceOrder,
      sourceContentHash: indexPage.contentHash,
      sourceRetrievedAt: retrievedAt,
    };
    const category = await tx.ruleCategory.findUnique({
      where: { slug: 'xenonrp-official-rulebook' },
      select: { id: true },
    });
    const savedCategory =
      category === null
        ? await tx.ruleCategory.create({ data: categoryData })
        : await tx.ruleCategory.update({ where: { id: category.id }, data: categoryData });

    const oldRows = await tx.rule.findMany({
      where: { categoryId: savedCategory.id },
      select: {
        id: true,
        sourceRoot: true,
        sourceUrl: true,
        sourcePath: true,
        sourceContentHash: true,
        sourceOrder: true,
        title: true,
        description: true,
        status: true,
      },
    });
    const byPath = new Map(oldRows.map((row) => [row.sourcePath ?? '', row]));
    const availableIds = new Set(oldRows.map((row) => row.id));
    const orderedRevisionIds: string[] = [];

    for (const page of importedPages) {
      const pathMatch = byPath.get(page.sourcePath);
      const contentMatch =
        pathMatch === undefined
          ? oldRows.find(
              (row) => availableIds.has(row.id) && row.sourceContentHash === page.contentHash,
            )
          : undefined;
      const existing = pathMatch ?? contentMatch;
      if (existing !== undefined) availableIds.delete(existing.id);

      const data = {
        categoryId: savedCategory.id,
        code: ruleCode(page),
        slug: ruleSlug(page),
        title: page.title,
        description: page.content,
        examples: null,
        severity: null,
        aliases: [],
        status: 'PUBLISHED' as const,
        sortOrder: page.sourceOrder,
        publishedAt: retrievedAt,
        sourceRoot: SOURCE_ROOT,
        sourceUrl: page.sourceUrl,
        sourcePath: page.sourcePath,
        sourceOrder: page.sourceOrder,
        sourceContentHash: page.contentHash,
        sourceRetrievedAt: retrievedAt,
      };

      const savedRule =
        existing === undefined
          ? await tx.rule.create({ data })
          : await tx.rule.update({ where: { id: existing.id }, data });

      let revisionChanged = existing === undefined;
      if (existing !== undefined) {
        revisionChanged =
          existing.sourceContentHash !== page.contentHash ||
          existing.sourcePath !== page.sourcePath ||
          existing.sourceOrder !== page.sourceOrder ||
          existing.sourceRoot !== SOURCE_ROOT ||
          existing.sourceUrl !== page.sourceUrl;
      }
      if (revisionChanged) {
        const latest = await tx.ruleRevision.findFirst({
          where: { ruleId: savedRule.id },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        await tx.ruleRevision.create({
          data: {
            ruleId: savedRule.id,
            version: (latest?.version ?? 0) + 1,
            title: page.title,
            description: page.content,
            examples: null,
            severity: null,
            editedBy: null,
            changeNote: `Updated XenonRP rulebook content (${snapshot.contentHash})`,
            contentHash: page.contentHash,
            sourceRoot: SOURCE_ROOT,
            sourceUrl: page.sourceUrl,
            sourcePath: page.sourcePath,
            sourceOrder: page.sourceOrder,
            sourceContentHash: page.contentHash,
            sourceRetrievedAt: retrievedAt,
          },
        });
      }

      const latestRevision = await tx.ruleRevision.findFirst({
        where: { ruleId: savedRule.id },
        orderBy: { version: 'desc' },
        select: { id: true },
      });
      if (latestRevision === null) throw new Error(`Missing revision for ${page.sourcePath}`);
      orderedRevisionIds.push(latestRevision.id);
    }

    const removedIds = [...availableIds];
    if (removedIds.length > 0) {
      await tx.rule.updateMany({
        where: { id: { in: removedIds } },
        data: { status: 'DRAFT' },
      });
    }
    const retiredOtherRules = await tx.rule.updateMany({
      where: {
        status: 'PUBLISHED',
        categoryId: { not: savedCategory.id },
      },
      data: { status: 'DRAFT' },
    });

    const latestSet = await tx.ruleSet.findFirst({
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    await tx.ruleSet.updateMany({
      where: { isCurrent: true },
      data: { isCurrent: false, retiredAt: new Date() },
    });
    const ruleSet = await tx.ruleSet.create({
      data: {
        version: (latestSet?.version ?? 0) + 1,
        revisionIds: orderedRevisionIds,
        publishedBy: null,
        note: 'Official XenonRP roleplay rulebook.',
        sourceRoot: SOURCE_ROOT,
        sourceContentHash: snapshot.contentHash,
        sourceRetrievedAt: retrievedAt,
        isCurrent: true,
      },
    });
    return {
      ruleSet,
      importedCount: orderedRevisionIds.length,
      retiredCount: removedIds.length + retiredOtherRules.count,
    };
  });

  await invalidatePublishedRulebookCache();
  log(
    `Published official ruleset v${String(result.ruleSet.version)}: ${String(result.importedCount)} page-level rules, hash ${snapshot.contentHash}; ${String(result.retiredCount)} previously published rules retired.`,
  );
}

async function verify(): Promise<void> {
  const snapshot = await readCandidate();
  const [current, category, publishedRuleCount] = await Promise.all([
    prisma.ruleSet.findFirst({ where: { isCurrent: true } }),
    prisma.ruleCategory.findUnique({
      where: { slug: 'xenonrp-official-rulebook' },
    }),
    prisma.rule.count({ where: { status: 'PUBLISHED' } }),
  ]);
  if (category === null) throw new Error('The official XenonRP rulebook category is missing.');
  const rules = await prisma.rule.findMany({
    where: { categoryId: category.id, status: 'PUBLISHED' },
    orderBy: { sourceOrder: 'asc' },
    select: {
      id: true,
      title: true,
      description: true,
      sourceUrl: true,
      sourcePath: true,
      sourceOrder: true,
      sourceContentHash: true,
    },
  });
  const indexPage = snapshot.pages[0];
  if (
    indexPage === undefined ||
    current?.sourceRoot !== SOURCE_ROOT ||
    current.sourceContentHash !== snapshot.contentHash ||
    category.description !== (indexPage.content || null) ||
    category.name !== indexPage.title ||
    category.sourceRoot !== SOURCE_ROOT ||
    category.sourceUrl !== indexPage.sourceUrl ||
    category.sourcePath !== indexPage.sourcePath ||
    category.sourceOrder !== indexPage.sourceOrder ||
    category.sourceContentHash !== indexPage.contentHash
  ) {
    throw new Error(
      'The current Xenon ruleset or its index content and provenance do not match the authored source.',
    );
  }

  const expected = snapshot.pages.filter((page) => page.sourceOrder !== 0);
  if (
    rules.length !== expected.length ||
    current.revisionIds.length !== expected.length ||
    publishedRuleCount !== expected.length
  ) {
    throw new Error(
      `Expected ${String(expected.length)} published imported rules and revisions; found ${String(rules.length)} source rules and ${String(publishedRuleCount)} published rules.`,
    );
  }
  const revisionRows = await prisma.ruleRevision.findMany({
    where: { id: { in: current.revisionIds } },
    select: {
      id: true,
      ruleId: true,
      title: true,
      description: true,
      contentHash: true,
      sourceUrl: true,
      sourcePath: true,
      sourceOrder: true,
      sourceContentHash: true,
    },
  });
  const revisionsById = new Map(revisionRows.map((revision) => [revision.id, revision]));

  for (const [index, page] of expected.entries()) {
    const rule = rules[index];
    const revisionId = current.revisionIds[index];
    const revision = revisionId === undefined ? undefined : revisionsById.get(revisionId);
    const expectedMatches =
      rule?.title === page.title &&
      rule.description === page.content &&
      rule.sourceUrl === page.sourceUrl &&
      rule.sourcePath === page.sourcePath &&
      rule.sourceOrder === page.sourceOrder &&
      rule.sourceContentHash === page.contentHash;
    const revisionMatches =
      revision?.ruleId === rule?.id &&
      revision?.title === page.title &&
      revision.description === page.content &&
      revision.contentHash === page.contentHash &&
      revision.sourceUrl === page.sourceUrl &&
      revision.sourcePath === page.sourcePath &&
      revision.sourceOrder === page.sourceOrder &&
      revision.sourceContentHash === page.contentHash;
    if (!expectedMatches || !revisionMatches) {
      throw new Error(`AUTHORED RULEBOOK CONTENT MISMATCH for ${page.title}.`);
    }
  }

  log(
    `RULEBOOK CONTENT VERIFIED — ${String(expected.length)} rules match the authored XenonRP Markdown.`,
  );
  log(`Version: ${String(current.version)} | hash: ${snapshot.contentHash}`);
}

const command = process.argv[2];
try {
  if (command === 'plan') await plan();
  else if (command === 'apply') await apply();
  else if (command === 'verify') await verify();
  else throw new Error('Usage: rules-sync.ts <plan|apply|verify>');
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await Promise.allSettled([prisma.$disconnect(), closeRedis()]);
}
