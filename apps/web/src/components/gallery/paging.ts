/**
 * Lightbox paging arithmetic.
 *
 * A separate module from the component purely so it can be tested. The app's
 * vitest setup transforms TypeScript but not JSX - `jsx: preserve` is correct
 * for Next, which does its own transform - so a test that imports the `.tsx`
 * cannot parse it. Keeping the one piece of real logic in a `.ts` file next to
 * the component is a smaller price than teaching the test runner to compile
 * React for the sake of six assertions.
 */

/**
 * The index `delta` steps away from `current`, wrapping at both ends.
 *
 * Wrapping matters: a viewer that dead-ends at the last photograph makes people
 * click back through sixty to reach the first. What it must never do is return
 * a negative index - `(0 - 1) % 5` is `-1` in JavaScript, not `4`, and the
 * component would ask for `items[-1]` the first time anyone pressed the left
 * arrow on the opening frame.
 */
export function stepIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (((current + delta) % length) + length) % length;
}
