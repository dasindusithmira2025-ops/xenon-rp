import { describe, expect, it } from 'vitest';

import { diffSourceText, extractSourcePage, sha256, sourceSnapshotHash } from './rule-source';

const markdown = `> For the complete documentation index, see [llms.txt](https://example.test/llms.txt). Markdown versions of documentation pages are available by appending .md; this page is available as [Markdown](https://example.test/rule.md).

# Rule 5.3 — නීතිය

<figure><img src="https://cdn.example.test/city_life_logo.png" alt=""><figcaption></figcaption></figure>

Rule 5.3: Keep this exactly! Sinhala සිංහල — café “quotes” &amp; symbols.

* English first.
  * Nested Sinhala: නීති.
    1. Second-level list item.

| Rule | සටහන |
| --- | --- |
| 5.3 | Keep, punctuation! |
`;

describe('official GitBook Markdown extraction', () => {
  it('preserves exact mixed-language content, numbering, paragraphs, nested lists, tables, and punctuation', () => {
    const extracted = extractSourcePage(markdown);

    expect(extracted.title).toBe('Rule 5.3 — නීතිය');
    expect(extracted.content).toBe(
      'Rule 5.3: Keep this exactly! Sinhala සිංහල — café “quotes” &amp; symbols.\n\n' +
        '* English first.\n' +
        '  * Nested Sinhala: නීති.\n' +
        '    1. Second-level list item.\n\n' +
        '| Rule | සටහන |\n' +
        '| --- | --- |\n' +
        '| 5.3 | Keep, punctuation! |\n',
    );
  });

  it('hashes exact extracted source and ordered page identities deterministically', () => {
    const extracted = extractSourcePage(markdown);
    const page = { ...extracted, sourcePath: '/rule-5-3' };

    expect(extracted.contentHash).toBe(sha256(`${extracted.title}\n${extracted.content}`));
    expect(sourceSnapshotHash([page])).toBe(sourceSnapshotHash([page]));
    expect(sourceSnapshotHash([page])).not.toBe(
      sourceSnapshotHash([{ ...page, sourcePath: '/rule-5-4' }]),
    );
  });

  it('shows changed lines in a reviewable source diff', () => {
    expect(diffSourceText('Rule 5.3\nFirst sentence.', 'Rule 5.3\nSecond sentence.')).toBe(
      '--- old revision\n+++ new source\n Rule 5.3\n-First sentence.\n+Second sentence.',
    );
  });
});
