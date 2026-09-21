import { describe, expect, it } from 'vitest';

import {
  formatPublicId,
  isPublicId,
  normalisePublicId,
  parsePublicId,
  publicIdKinds,
} from './public-id';

describe('formatPublicId', () => {
  it('pads users to five digits and omits the segment', () => {
    expect(formatPublicId(10082, null, 5)).toBe('XN-10082');
    expect(formatPublicId(7, null, 5)).toBe('XN-00007');
  });

  it('includes the segment for scoped entities', () => {
    expect(formatPublicId(1842, 'WL', 4)).toBe('XN-WL-1842');
    expect(formatPublicId(452, 'TK', 4)).toBe('XN-TK-0452');
    expect(formatPublicId(5819, 'CH', 4)).toBe('XN-CH-5819');
  });

  it('does not truncate a number wider than the padding', () => {
    expect(formatPublicId(123456, 'WL', 4)).toBe('XN-WL-123456');
  });

  it('rejects a sequence that is not a positive integer', () => {
    expect(() => formatPublicId(0, null, 5)).toThrow(RangeError);
    expect(() => formatPublicId(-1, null, 5)).toThrow(RangeError);
    expect(() => formatPublicId(1.5, null, 5)).toThrow(RangeError);
  });

  it('rejects a malformed segment', () => {
    expect(() => formatPublicId(1, 'w', 4)).toThrow(RangeError);
    expect(() => formatPublicId(1, 'TOOLONG', 4)).toThrow(RangeError);
    expect(() => formatPublicId(1, 'W1', 4)).toThrow(RangeError);
  });
});

describe('parsePublicId', () => {
  it('round-trips every kind', () => {
    for (const [kind, spec] of Object.entries(publicIdKinds)) {
      const segment = spec.segment ?? (kind === 'application' ? 'WL' : null);
      const formatted = formatPublicId(1234, segment, spec.pad);
      expect(parsePublicId(formatted), kind).toEqual({ segment, sequence: 1234 });
    }
  });

  it('is case and whitespace insensitive', () => {
    expect(parsePublicId('  xn-wl-1842 ')).toEqual({ segment: 'WL', sequence: 1842 });
  });

  it('strips leading zeros from the number', () => {
    expect(parsePublicId('XN-TK-0452')).toEqual({ segment: 'TK', sequence: 452 });
  });

  it('returns null for things that merely look similar', () => {
    for (const bad of ['', 'XN', 'XN-', 'XN-WL', 'ZZ-WL-1842', 'XN-WL-12', 'XN-TOOLONG-1234']) {
      expect(parsePublicId(bad), bad).toBeNull();
    }
  });
});

describe('isPublicId', () => {
  it('accepts valid identifiers and rejects the rest', () => {
    expect(isPublicId('XN-10082')).toBe(true);
    expect(isPublicId('XN-WL-1842')).toBe(true);
    expect(isPublicId('1842')).toBe(false);
  });
});

describe('normalisePublicId', () => {
  it('accepts the forms staff actually type', () => {
    expect(normalisePublicId('xn-wl-1842')).toBe('XN-WL-1842');
    expect(normalisePublicId('XN WL 1842')).toBe('XN-WL-1842');
    expect(normalisePublicId('xn_wl_1842')).toBe('XN-WL-1842');
    // Prefix dropped entirely.
    expect(normalisePublicId('WL-1842')).toBe('XN-WL-1842');
  });

  it('uses the fallback segment for a bare number', () => {
    expect(normalisePublicId('1842', 'WL')).toBe('XN-WL-1842');
  });

  it('refuses a bare number when the caller gives no context', () => {
    // Ambiguous between a user and a submission. Guessing would route staff to
    // an unrelated record that really exists, which is worse than no answer.
    expect(normalisePublicId('1842')).toBeNull();
  });

  it('reads a bare number as a user when told to', () => {
    expect(normalisePublicId('10082', null)).toBe('XN-10082');
  });

  it('returns null for input it cannot make sense of', () => {
    expect(normalisePublicId('not an id')).toBeNull();
    expect(normalisePublicId('')).toBeNull();
  });
});
