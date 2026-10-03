'use client';

import * as React from 'react';

import { AnimatePresence, motion } from '@xenon/ui/motion';

import { XenonMark } from '~/components/brand/wordmark';

/**
 * First entry.
 *
 * A short held moment before the homepage resolves: a hairline strikes across
 * the black, the mark catches a light, and the whole thing lifts off the hero.
 * Roughly 1.2 seconds, which is about as long as a title card can hold before
 * it stops being cinematic and starts being an obstacle.
 *
 * Three decisions worth defending:
 *
 *  - The overlay is `--color-void`, the same colour as the page behind it. A
 *    visitor whose JavaScript is slow, or who has turned it off, sees the site
 *    background rather than an intro that never leaves. There is no state in
 *    which this component can trap a page.
 *  - It is rendered in the server HTML rather than mounted after hydration, so
 *    it is what the first paint already shows. An intro that fades in on top of
 *    a hero the visitor has already seen is a curtain closing, not opening.
 *  - It plays once per tab. A client-side navigation never remounts it because
 *    it lives in the layout, and `sessionStorage` catches the reload case, so
 *    going Home → Rules → Home does not replay it.
 *
 * Reduced motion removes it outright: this is pure atmosphere and carries no
 * information, so the correct reduced-motion behaviour is for it not to exist.
 */

const SEEN_KEY = 'xenon:entered';

/** Line strikes, mark resolves, curtain lifts. */
const SEQUENCE_MS = 1_150;

/**
 * How long the hero should hold before it starts revealing.
 *
 * Slightly less than the full sequence, so the headline is already on its way
 * up as the curtain fades. The overlap is what makes the two read as one shot
 * rather than as an intro followed by a page.
 */
const HOLD_SECONDS = 0.9;

/**
 * Whether this page load gets the sequence.
 *
 * Read-only, and called from a `useState` initialiser rather than from an
 * effect. That is not a style preference - it is the only correct place.
 *
 * Under Strict Mode in development React mounts, runs effects, tears them down
 * and runs them again. An effect that both reads the flag and sets it therefore
 * reads its own write on the second pass, concludes the visitor has been here
 * before, and skips the sequence every single time. The bug is invisible in
 * production and total in development, which is the worst combination.
 *
 * Every `useState` initialiser in a render pass runs before any effect in that
 * pass, so both this component and the hero observe the flag as it was on
 * arrival, whatever Strict Mode does afterwards.
 */
function shouldPlaySequence(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    if (window.sessionStorage.getItem(SEEN_KEY) !== null) return false;
  } catch {
    // Storage unavailable: treat it as a first visit and play the sequence.
  }
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The delay the hero should apply to its own entrance, in seconds.
 *
 * Resolved during the first client render rather than in an effect, because by
 * the time effects run the hero's animation has already started - and a hero
 * that plays its reveal behind the curtain has no reveal at all.
 */
export function useEntryDelay(): number {
  const [delay] = React.useState(() => (shouldPlaySequence() ? HOLD_SECONDS : 0));
  return delay;
}

export function FirstEntry(): React.ReactElement {
  const [playing, setPlaying] = React.useState(true);
  const [hold] = React.useState(() => (shouldPlaySequence() ? SEQUENCE_MS : 0));

  React.useEffect(() => {
    // `sessionStorage` throws outright in a locked-down or partitioned context.
    // A failure to write it costs a replayed intro on the next reload, nothing
    // more, so it is swallowed.
    try {
      window.sessionStorage.setItem(SEEN_KEY, '1');
    } catch {
      // Ignored deliberately: see above.
    }

    // Zero rather than a skipped timer, so the curtain comes up through the
    // same path in every case and there is only one exit to reason about.
    const timer = setTimeout(() => {
      setPlaying(false);
    }, hold);

    return () => {
      clearTimeout(timer);
    };
  }, [hold]);

  return (
    <AnimatePresence>
      {playing ? (
        <motion.div
          key="first-entry"
          // Above the header but below a modal: nothing can open over it in the
          // second it is on screen, and it must not sit over a dialog if one did.
          className="pointer-events-none fixed inset-0 z-65 flex items-center justify-center bg-void"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.45, ease: [0.4, 0, 1, 1] }}
          aria-hidden
        >
          <div className="relative flex items-center justify-center">
            {/* The mark, arriving out of the line with a single light passing
                across the chrome. `x-chrome-sweep` runs once and stops. */}
            <motion.span
              className="x-chrome-sweep relative block"
              initial={{ opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.55, delay: 0.42, ease: [0.16, 1, 0.3, 1] }}
            >
              <XenonMark className="size-12" />
            </motion.span>

            {/* The strike. Expands from nothing to a hairline the width of the
                mark and settles under it as a baseline - below rather than
                through, so it frames the logo instead of crossing it out. */}
            <motion.span
              className="absolute -bottom-3.5 left-1/2 h-px w-24 -translate-x-1/2 bg-xenon shadow-[0_0_12px_1px_#2afd23aa]"
              initial={{ scaleX: 0, opacity: 0 }}
              animate={{ scaleX: 1, opacity: [0, 1, 1, 0.45] }}
              transition={{ duration: 0.75, ease: [0.16, 1, 0.3, 1], times: [0, 0.3, 0.7, 1] }}
            />
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
