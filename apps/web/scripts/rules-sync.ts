import '@xenon/config/load-env';

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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

const SOURCE_ROOT = 'https://mycompany-181.gitbook.io/cityliferpgangrule-docs';
const CANDIDATE_FILE = fileURLToPath(
  new URL('../../../docs/rules/official-snapshot.json', import.meta.url),
);

interface IndexPage {
  readonly label: string;
  readonly url: string;
  readonly path: string;
}

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

function sourcePathFor(url: string): string {
  const parsed = new URL(url);
  const base = new URL(SOURCE_ROOT).pathname.replace(/\/$/, '');
  const path = parsed.pathname.startsWith(`${base}/`)
    ? parsed.pathname.slice(base.length)
    : parsed.pathname === base
      ? '/'
      : null;
  if (path === null) throw new Error(`Source URL is outside the official GitBook: ${url}`);
  return path.replace(/\.md$/, '') || '/';
}

function decodeHtmlHref(value: string): string {
  return value.replaceAll('&amp;', '&').replaceAll('&#x2F;', '/');
}

function decodeXmlText(value: string): string {
  return value.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>');
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { accept: 'text/markdown, text/plain, text/html;q=0.9, */*;q=0.8' },
    signal: AbortSignal.timeout(35_000),
  });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)} ${response.statusText}`);
  return response.text();
}

function pagesFromIndex(index: string): readonly IndexPage[] {
  const pages: IndexPage[] = [];
  for (const line of index.split(/\r?\n/)) {
    const match = /^\s*-\s+\[([^\]]+)\]\((https?:\/\/[^)]+\.md)\)\s*$/.exec(line);
    if (match === null) continue;
    const url = decodeHtmlHref(match[2] ?? '');
    pages.push({ label: match[1] ?? '', url, path: sourcePathFor(url) });
  }
  if (pages.length === 0) throw new Error('Official GitBook llms.txt lists no Markdown pages.');
  if (new Set(pages.map((page) => page.path)).size !== pages.length) {
    throw new Error('Official GitBook llms.txt contains duplicate source paths.');
  }
  return pages;
}

function pagePathsFromSitemap(sitemap: string): readonly string[] {
  const paths: string[] = [];
  for (const match of sitemap.matchAll(/<loc>([\s\S]*?)<\/loc>/g)) {
    const href = decodeXmlText(match[1] ?? '').trim();
    let parsed: URL;
    try {
      parsed = new URL(href);
    } catch {
      continue;
    }
    if (parsed.origin !== new URL(SOURCE_ROOT).origin) continue;
    if (parsed.search.length > 0 || parsed.hash.length > 0) continue;
    paths.push(sourcePathFor(parsed.href));
  }
  return paths;
}

function extractSnapshotPage(
  page: IndexPage,
  rawMarkdown: string,
  sourceOrder: number,
): SourceRulePage {
  const extracted = extractSourcePage(rawMarkdown);
  return {
    sourceUrl: page.url,
    sourcePath: page.path,
    sourceOrder,
    title: extracted.title,
    content: extracted.content,
    contentHash: extracted.contentHash,
    rawMarkdown,
  };
}

async function fetchOfficialSnapshot(): Promise<RuleSourceSnapshot> {
  const retrievedAt = new Date().toISOString();
  const [index, sitemap] = await Promise.all([
    fetchText(`${SOURCE_ROOT}/llms.txt`),
    fetchText(`${SOURCE_ROOT}/sitemap-pages.xml`),
  ]);
  const listed = pagesFromIndex(index);
  const sitemapPaths = pagePathsFromSitemap(sitemap);
  const indexPaths = listed.map((page) => page.path);
  if (sitemapPaths[0] !== '/') {
    throw new Error('The GitBook page sitemap does not begin with its root page.');
  }
  const expectedIndexPaths = [listed[0]?.path ?? '', ...sitemapPaths.slice(1)];
  if (
    sitemapPaths.length !== listed.length ||
    JSON.stringify(expectedIndexPaths) !== JSON.stringify(indexPaths)
  ) {
    const missingFromIndex = expectedIndexPaths.filter((path) => !indexPaths.includes(path));
    const missingFromSitemap = indexPaths.filter((path) => !expectedIndexPaths.includes(path));
    throw new Error(
      `GitBook sitemap and llms.txt disagree. Missing from index: ${missingFromIndex.join(', ') || 'none'}; missing from sitemap: ${missingFromSitemap.join(', ') || 'none'}`,
    );
  }

  const pages: SourceRulePage[] = [];
  const failures: string[] = [];
  for (let start = 0; start < listed.length; start += 4) {
    const group = listed.slice(start, start + 4);
    const fetched = await Promise.all(
      group.map(async (page, offset) => {
        try {
          return extractSnapshotPage(page, await fetchText(page.url), start + offset);
        } catch (error) {
          failures.push(`${page.label} | ${page.url} | ${String(error)}`);
          return null;
        }
      }),
    );
    pages.push(...fetched.filter((page): page is SourceRulePage => page !== null));
  }
  if (failures.length > 0) {
    throw new Error(`Official GitBook pages could not be retrieved:\n${failures.join('\n')}`);
  }
  const firstPage = pages[0];
  if (firstPage === undefined) {
    throw new Error('The first source page is not the GitBook root page.');
  }

  return {
    schemaVersion: 1,
    sourceRoot: SOURCE_ROOT,
    sourceTitle: firstPage.title,
    retrievedAt,
    contentHash: sourceSnapshotHash(pages),
    pages,
  };
}

function validateSnapshot(snapshot: RuleSourceSnapshot): void {
  if (snapshot.schemaVersion !== 1 || snapshot.sourceRoot !== SOURCE_ROOT) {
    throw new Error('Candidate snapshot schema or source root is not supported.');
  }
  if (snapshot.pages.length === 0 || snapshot.pages[0]?.sourceOrder !== 0) {
    throw new Error('Candidate snapshot does not begin with its index page.');
  }
  const paths = new Set<string>();
  for (const [order, page] of snapshot.pages.entries()) {
    if (paths.has(page.sourcePath)) throw new Error(`Duplicate source path: ${page.sourcePath}`);
    paths.add(page.sourcePath);
    if (page.sourceOrder !== order || sourcePathFor(page.sourceUrl) !== page.sourcePath) {
      throw new Error(`Invalid provenance/order metadata for ${page.sourceUrl}`);
    }
    const extracted = extractSourcePage(page.rawMarkdown);
    if (
      extracted.title !== page.title ||
      extracted.content !== page.content ||
      extracted.contentHash !== page.contentHash
    ) {
      throw new Error(`Snapshot text/hash does not match its raw source page: ${page.sourceUrl}`);
    }
  }
  if (sourceSnapshotHash(snapshot.pages) !== snapshot.contentHash) {
    throw new Error('Snapshot manifest content hash does not match its ordered pages.');
  }
}

async function readCandidate(): Promise<RuleSourceSnapshot> {
  const snapshot = JSON.parse(await readFile(CANDIDATE_FILE, 'utf8')) as RuleSourceSnapshot;
  validateSnapshot(snapshot);
  return snapshot;
}

async function saveCandidate(snapshot: RuleSourceSnapshot): Promise<void> {
  await mkdir(dirname(CANDIDATE_FILE), { recursive: true });
  await writeFile(CANDIDATE_FILE, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

function diffPage(oldPage: { title: string; description: string }, page: SourceRulePage): string {
  return diffSourceText(
    `# ${oldPage.title}\n\n${oldPage.description}`,
    `# ${page.title}\n\n${page.content}`,
  );
}

async function plan(): Promise<void> {
  const snapshot = await fetchOfficialSnapshot();
  await saveCandidate(snapshot);

  const [categories, rules, current, otherPublishedCount] = await Promise.all([
    prisma.ruleCategory.findMany({ where: { sourceRoot: SOURCE_ROOT } }),
    prisma.rule.findMany({
      where: { sourceRoot: SOURCE_ROOT },
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
    }),
    prisma.ruleSet.findFirst({ where: { isCurrent: true } }),
    prisma.rule.count({
      where: {
        status: 'PUBLISHED',
        OR: [{ sourceRoot: null }, { sourceRoot: { not: SOURCE_ROOT } }],
      },
    }),
  ]);
  const category = categories.find((candidate) => candidate.sourceOrder === 0) ?? null;
  const oldByPath = new Map(rules.map((rule) => [rule.sourcePath ?? '', rule as ExistingRule]));
  const unmatchedOld = new Set(rules.map((rule) => rule.id));
  const pageLines: string[] = [];

  for (const page of snapshot.pages) {
    if (page.sourceOrder === 0) {
      if (category === null) pageLines.push(`[NEW PAGE] / | ${page.title}`);
      else if (category.sourceContentHash !== page.contentHash) {
        pageLines.push(`[CHANGED PAGE] / | ${page.title}`);
        pageLines.push(
          diffSourceText(`# ${category.name}\n\n`, `# ${page.title}\n\n${page.content}`),
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

  log(`Official source: ${SOURCE_ROOT}`);
  log(`Retrieved: ${snapshot.retrievedAt}`);
  log(
    `Pages discovered: ${String(snapshot.pages.length)} (1 index, ${String(snapshot.pages.length - 1)} rule pages)`,
  );
  log(
    `Published Xenon ruleset: ${current?.version === undefined ? 'none' : `v${String(current.version)}`}`,
  );
  if (otherPublishedCount > 0) {
    log(`Published non-GitBook rules to retire on apply: ${String(otherPublishedCount)}`);
  }
  log(`Source content hash: ${snapshot.contentHash}`);
  log('--- PLAN (database unchanged) ---');
  for (const line of pageLines) log(line);
  log(`Candidate snapshot: ${CANDIDATE_FILE}`);
}

function ruleSlug(page: SourceRulePage): string {
  return page.sourcePath.replace(/^\//, '');
}

function ruleCode(page: SourceRulePage): string {
  return `source-${ruleSlug(page)}`;
}

async function apply(): Promise<void> {
  const snapshot = await readCandidate();
  const importedPages = snapshot.pages.filter((page) => page.sourceOrder !== 0);
  if (importedPages.length === 0) throw new Error('The official snapshot contains no rule pages.');

  const [existingRules, foreignPublished, current] = await Promise.all([
    prisma.rule.findMany({
      where: { sourceRoot: SOURCE_ROOT },
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
    }),
    prisma.rule.count({
      where: {
        status: 'PUBLISHED',
        OR: [{ sourceRoot: null }, { sourceRoot: { not: SOURCE_ROOT } }],
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
    if (indexPage === undefined) throw new Error('Official snapshot index page is missing.');
    const categoryData = {
      slug: 'citylife-official-rulebook',
      name: indexPage.title,
      description: null,
      sortOrder: 0,
      sourceRoot: SOURCE_ROOT,
      sourceUrl: indexPage.sourceUrl,
      sourcePath: indexPage.sourcePath,
      sourcePageTitle: indexPage.title,
      sourceOrder: indexPage.sourceOrder,
      sourceContentHash: indexPage.contentHash,
      sourceRetrievedAt: retrievedAt,
    };
    const category = await tx.ruleCategory.findFirst({
      where: { sourceRoot: SOURCE_ROOT, sourceOrder: 0 },
      select: { id: true },
    });
    const savedCategory =
      category === null
        ? await tx.ruleCategory.create({ data: categoryData })
        : await tx.ruleCategory.update({ where: { id: category.id }, data: categoryData });

    const oldRows = await tx.rule.findMany({
      where: { sourceRoot: SOURCE_ROOT },
      select: {
        id: true,
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
          existing.sourceOrder !== page.sourceOrder;
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
            changeNote: `Official GitBook sync ${snapshot.contentHash}`,
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
    await tx.rule.updateMany({
      where: { status: 'PUBLISHED', sourceRoot: null },
      data: { status: 'DRAFT' },
    });
    await tx.rule.updateMany({
      where: { status: 'PUBLISHED', sourceRoot: { not: SOURCE_ROOT } },
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
        note: 'Official XenonRP rulebook imported from GitBook.',
        sourceRoot: SOURCE_ROOT,
        sourceContentHash: snapshot.contentHash,
        sourceRetrievedAt: retrievedAt,
        isCurrent: true,
      },
    });
    return { ruleSet, importedCount: orderedRevisionIds.length, removedCount: removedIds.length };
  });

  await invalidatePublishedRulebookCache();
  log(
    `Published official ruleset v${String(result.ruleSet.version)}: ${String(result.importedCount)} page-level rules, hash ${snapshot.contentHash}; ${String(result.removedCount)} source pages retired from the current set.`,
  );
}

async function verify(): Promise<void> {
  const snapshot = await readCandidate();
  const live = await fetchOfficialSnapshot();
  if (live.contentHash !== snapshot.contentHash) {
    throw new Error(
      `Current GitBook content hash ${live.contentHash} differs from the imported snapshot ${snapshot.contentHash}. Run rules:sync:plan and review the diff.`,
    );
  }

  const [current, categories, rules, publishedRuleCount] = await Promise.all([
    prisma.ruleSet.findFirst({ where: { isCurrent: true } }),
    prisma.ruleCategory.findMany({ where: { sourceRoot: SOURCE_ROOT } }),
    prisma.rule.findMany({
      where: { sourceRoot: SOURCE_ROOT, status: 'PUBLISHED' },
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
    }),
    prisma.rule.count({ where: { status: 'PUBLISHED' } }),
  ]);
  const indexPage = snapshot.pages[0];
  const category = categories.find((item) => item.sourceOrder === 0);
  if (
    indexPage === undefined ||
    category === undefined ||
    current?.sourceRoot !== SOURCE_ROOT ||
    current.sourceContentHash !== snapshot.contentHash ||
    category.name !== indexPage.title ||
    category.sourceRoot !== SOURCE_ROOT ||
    category.sourceUrl !== indexPage.sourceUrl ||
    category.sourcePath !== indexPage.sourcePath ||
    category.sourceOrder !== indexPage.sourceOrder ||
    category.sourceContentHash !== indexPage.contentHash
  ) {
    throw new Error(
      'The current Xenon ruleset or its index provenance does not match the snapshot.',
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
      throw new Error(`SOURCE TEXT FIDELITY FAILED for ${page.sourceUrl}`);
    }
  }

  log(
    `SOURCE TEXT FIDELITY VERIFIED — ${String(expected.length)} rules match current GitBook Markdown exactly.`,
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
