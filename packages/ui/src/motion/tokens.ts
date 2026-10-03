import type { Transition } from 'motion/react';

/**
 * Xenon motion tokens.
 *
 * One source of truth for how long anything takes and how it accelerates.
 * The point is not that these numbers are magic - they are tuned by eye - but
 * that there is exactly one of each, so a card, a drawer and a progress fill
 * that should feel like the same system actually do.
 *
 * Mirrored by `--duration-*` / `--ease-*` in theme.css. CSS transitions read
 * the custom properties; anything driven by Motion reads these. Change one,
 * change the other.
 */

/** Seconds, because that is what Motion takes. */
export const duration = {
  /** Press feedback, checkbox ticks - anything that must feel like a key travelling. */
  instant: 0.12,
  /** Hover, focus, colour and border changes. */
  fast: 0.2,
  /** Interface transitions: tabs, dropdowns, toasts, status changes. */
  normal: 0.32,
  /** Modals, drawers, list reflow. */
  moderate: 0.45,
  /** Section entrances on scroll. */
  slow: 0.62,
  /** Hero typography, full-bleed media reveals. Used a handful of times. */
  cinematic: 1.0,
} as const;

/** Milliseconds, for `setTimeout` and CSS-in-JS that wants a number. */
export const durationMs = {
  instant: 120,
  fast: 200,
  normal: 320,
  moderate: 450,
  slow: 620,
  cinematic: 1000,
} as const;

/**
 * Curves.
 *
 * `standard` is the workhorse: fast out of the gate, settles without
 * overshoot. `emphasized` is the cinematic one - it travels most of the
 * distance almost immediately, which is what makes a masked headline read as
 * type being set rather than as a box sliding.
 */
export const ease = {
  standard: [0.32, 0.72, 0, 1],
  emphasized: [0.16, 1, 0.3, 1],
  /** Entrances: decelerate into place. */
  enter: [0, 0, 0.2, 1],
  /** Exits: accelerate away. Always shorter than the matching entrance. */
  exit: [0.4, 0, 1, 1],
} as const;

/** A single spring, for the two or three places a spring is genuinely right. */
export const spring = { type: 'spring', stiffness: 420, damping: 38, mass: 0.9 } as const;

/** The stagger step between siblings, and the cap that keeps long lists sane. */
export const stagger = {
  step: 0.06,
  /** No list may take longer than this to finish arriving, however long it is. */
  maxTotal: 0.5,
} as const;

/**
 * Stagger delay for item `index` of `count`.
 *
 * A twenty-item grid at a flat 60ms per item takes 1.2s to finish, by which
 * point the last row has been on screen unanimated for half a second. The step
 * compresses instead.
 */
export function staggerDelay(index: number, count: number): number {
  if (count <= 1) return 0;
  const step = Math.min(stagger.step, stagger.maxTotal / (count - 1));
  return index * step;
}

/**
 * A transition that completes instantly when the viewer asked for less motion.
 *
 * The whole reduced-motion strategy in one function, and the important part is
 * what it does *not* touch: the element tree and the `initial` state stay
 * identical either way.
 *
 * Branching those instead - rendering a plain `<div>` for reduced motion and a
 * `<motion.div>` otherwise - is the obvious approach and it is broken. These
 * components render on the server, where the preference is unknowable, so the
 * server always emits the animated markup including the inline `opacity: 0`
 * Motion writes for its initial state. A visitor with reduced motion set then
 * hydrates different markup over it and gets a hydration mismatch: their
 * reward for setting an accessibility preference is a console full of React
 * errors and a subtree rebuilt from scratch.
 *
 * Zero duration means the element snaps to its final state the moment it
 * qualifies. No travel, no fade, nothing to trigger vestibular symptoms - and
 * markup the server and the browser agree on.
 */
export function instant(reduced: boolean | null, transition: Transition): Transition {
  return reduced === true ? { duration: 0 } : transition;
}
