import { createHash } from 'node:crypto';

export interface ExtractedSourcePage {
  readonly title: string;
  /** Markdown body copied byte-for-byte after the page H1 and decorative logo. */
  readonly content: string;
  readonly contentHash: string;
}

export interface SourceRulePage extends ExtractedSourcePage {
  readonly sourceUrl: string;
  readonly sourcePath: string;
  readonly sourceOrder: number;
  /** Full GitBook Markdown response, retained for audit and exact re-import. */
  readonly rawMarkdown: string;
}

export interface RuleSourceSnapshot {
  readonly schemaVersion: number;
  readonly sourceRoot: string;
  readonly sourceTitle: string;
  readonly retrievedAt: string;
  readonly contentHash: string;
  readonly pages: readonly SourceRulePage[];
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Remove only GitBook's generated access note, page-title line, and the
 * source's decorative CityLife logo. The raw response remains alongside this
 * extracted body. No content words, punctuation, or meaningful whitespace are
 * normalized.
 */
export function extractSourcePage(markdown: string): ExtractedSourcePage {
  const headingStart = markdown.search(/^# /m);
  if (headingStart < 0) throw new Error('GitBook Markdown has no page H1.');

  const generatedPreamble = markdown.slice(0, headingStart);
  if (
    !generatedPreamble.includes('llms.txt') ||
    !generatedPreamble.includes('available as [Markdown]')
  ) {
    throw new Error('GitBook Markdown is missing its expected generated provenance note.');
  }

  const lineEnd = markdown.indexOf('\n', headingStart);
  if (lineEnd < 0) throw new Error('GitBook page H1 has no following content boundary.');
  const heading = markdown.slice(headingStart, lineEnd).replace(/\r$/, '');
  const title = heading.slice(2);
  if (title.length === 0) throw new Error('GitBook page H1 is empty.');

  let bodyStart = lineEnd + 1;
  if (markdown.startsWith('\r\n', bodyStart)) bodyStart += 2;
  else if (markdown.startsWith('\n', bodyStart)) bodyStart += 1;

  let content = markdown.slice(bodyStart);
  const decorativeFigure =
    /^(?:<figure>[\s\S]*?city_life_logo[\s\S]*?<\/figure>|<img\b[^\r\n]*city_life_logo[^\r\n]*>)(?:\r?\n){1,2}/i;
  content = content.replace(decorativeFigure, '');

  return { title, content, contentHash: sha256(`${title}\n${content}`) };
}

export function sourceSnapshotHash(
  pages: readonly Pick<SourceRulePage, 'sourcePath' | 'contentHash'>[],
): string {
  return sha256(pages.map((page) => `${page.sourcePath}\0${page.contentHash}`).join('\n'));
}

/** Produce a deterministic line diff without normalizing source text. */
export function diffSourceText(oldText: string, newText: string): string {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const rows = oldLines.length + 1;
  const columns = newLines.length + 1;
  if (rows * columns > 1_000_000) {
    return `--- old\n+++ new\n- ${oldText}\n+ ${newText}`;
  }

  const lcs = Array.from({ length: rows }, () => new Uint32Array(columns));
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    const currentRow = lcs[i];
    if (currentRow === undefined) continue;
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      currentRow[j] =
        oldLines[i] === newLines[j]
          ? 1 + (lcs[i + 1]?.[j + 1] ?? 0)
          : Math.max(lcs[i + 1]?.[j] ?? 0, lcs[i]?.[j + 1] ?? 0);
    }
  }

  const diff: string[] = ['--- old revision', '+++ new source'];
  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      diff.push(` ${oldLines[i] ?? ''}`);
      i += 1;
      j += 1;
    } else if (
      i < oldLines.length &&
      (j >= newLines.length || (lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0))
    ) {
      diff.push(`-${oldLines[i] ?? ''}`);
      i += 1;
    } else {
      diff.push(`+${newLines[j] ?? ''}`);
      j += 1;
    }
  }
  return diff.join('\n');
}
