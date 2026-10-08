import { describe, expect, it } from 'vitest';

import { diffSourceText, extractSourcePage, sha256, sourceSnapshotHash } from './rule-source';

const markdown = `# Rule 5.3 — නීතිය

Rule 5.3: Keep this exactly! Sinhala සිංහල — café “quotes” &amp; symbols.

* English first.
  * Nested Sinhala: නීති.
    1. Second-level list item.

| Rule | සටහන |
| --- | --- |
| 5.3 | Keep, punctuation! |
`;

describe('authored Markdown page extraction', () => {
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

  it('hashes authored content and ordered page identities deterministically', () => {
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
