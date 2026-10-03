import { describe, expect, it } from 'vitest';

import { stepIndex } from './paging';

/**
 * The lightbox's paging arithmetic.
 *
 * The rest of the viewer is markup and a Radix dialog; this is the only part
 * that can be wrong in a way nobody notices until someone presses the left
 * arrow on the first photograph and the component asks for `items[-1]`.
 */
describe('stepIndex', () => {
  it('moves forward and back within range', () => {
    expect(stepIndex(2, 1, 5)).toBe(3);
    expect(stepIndex(2, -1, 5)).toBe(1);
  });

  it('wraps past the last photograph to the first', () => {
    expect(stepIndex(4, 1, 5)).toBe(0);
  });

  it('wraps back from the first photograph to the last', () => {
    // The bug this exists for: `(0 - 1) % 5` is -1 in JavaScript, not 4.
    expect(stepIndex(0, -1, 5)).toBe(4);
  });

  it('never returns a negative index for a jump larger than the set', () => {
    expect(stepIndex(0, -7, 5)).toBe(3);
    expect(stepIndex(0, -12, 5)).toBe(3);
  });

  it('is a no-op on a single photograph', () => {
    expect(stepIndex(0, 1, 1)).toBe(0);
    expect(stepIndex(0, -1, 1)).toBe(0);
  });

  it('survives an empty gallery rather than returning NaN', () => {
    expect(stepIndex(0, 1, 0)).toBe(0);
  });
});
