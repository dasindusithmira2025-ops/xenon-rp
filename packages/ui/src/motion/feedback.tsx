'use client';

import { animate, AnimatePresence, motion, useInView, useReducedMotion } from 'motion/react';
import * as React from 'react';

import { cn } from '../lib/cn';

import { duration, ease, instant } from './tokens';

/**
 * State and feedback motion.
 *
 * Everything here animates a change in something true: a number that moved, a
 * server that came online, an action that succeeded, a row that left a list.
 * None of it loops for decoration.
 */

/**
 * `useLayoutEffect` that does not warn during server rendering.
 *
 * These are client components, but they still render on the server for the
 * initial HTML, and React logs for a layout effect in that pass.
 */
const useIsomorphicLayoutEffect =
  typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect;

// --- Counter -----------------------------------------------------------------

export interface AnimatedCounterProps {
  /** The real figure. Rendered verbatim in the server HTML. */
  value: number;
  /**
   * Count up from zero the first time the element is scrolled into view.
   *
   * True for a statistic being presented - "1,892 whitelisted citizens" - where
   * the count is the reveal. False for a live reading such as the player count,
   * where restarting from zero on every poll would be a lie about the city
   * emptying.
   */
  countOnReveal?: boolean;
  locale?: string;
  className?: string;
}

/**
 * A figure that animates between real values.
 *
 * Writes straight to the text node rather than through React state. That is
 * what keeps a 60fps tween from queueing sixty renders a second, and it means
 * the server-rendered HTML contains the true number - correct for search
 * engines, for reader modes, and for anyone whose JavaScript never arrives.
 */
export function AnimatedCounter({
  value,
  countOnReveal = true,
  locale = 'en-GB',
  className,
}: AnimatedCounterProps): React.ReactElement {
  const reduced = useReducedMotion();
  const ref = React.useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.6 });

  // Where the next tween starts. A reveal counts from zero; a live value counts
  // from whatever was last on screen.
  const fromRef = React.useRef(countOnReveal ? 0 : value);

  const format = React.useCallback(
    (input: number) => Math.round(input).toLocaleString(locale),
    [locale],
  );

  /*
   * Reset to zero before the browser paints, not after.
   *
   * Without this the element shows the true figure from the server HTML, then
   * snaps back to zero when it scrolls into view - the count reads as a glitch
   * rather than as a reveal. A layout effect lands the starting value in the
   * same frame as hydration, so nothing is ever visibly undone.
   *
   * The media query is read directly rather than through `useReducedMotion`,
   * which has not resolved yet this early in the client's life.
   */
  useIsomorphicLayoutEffect(() => {
    const node = ref.current;
    if (node === null || !countOnReveal) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    node.textContent = format(0);
  }, [countOnReveal, format]);

  React.useEffect(() => {
    const node = ref.current;
    if (node === null) return;

    if (reduced === true) {
      node.textContent = format(value);
      fromRef.current = value;
      return;
    }

    // A reveal counter waits to be seen. A live counter updates wherever it is,
    // because the value changing is the event.
    if (countOnReveal && !inView) return;

    const from = fromRef.current;
    fromRef.current = value;

    if (from === value) {
      node.textContent = format(value);
      return;
    }

    // Scaled to the distance travelled and capped: counting to 12 should not
    // take as long as counting to 12,000, and neither should take two seconds.
    const distance = Math.abs(value - from);
    const seconds = Math.min(1.4, Math.max(0.35, Math.log10(distance + 1) * 0.42));

    const controls = animate(from, value, {
      duration: seconds,
      ease: ease.emphasized,
      onUpdate: (latest) => {
        node.textContent = format(latest);
      },
    });

    return () => {
      controls.stop();
    };
  }, [value, inView, reduced, countOnReveal, format]);

  return (
    <span ref={ref} className={cn('x-tabular', className)}>
      {format(value)}
    </span>
  );
}

// --- Success -----------------------------------------------------------------

/**
 * A check that draws itself.
 *
 * For the handful of moments that genuinely deserve marking: an application
 * submitted, an identity linked, a ticket resolved. Not confetti - these are
 * administrative outcomes, and a burst of particles over "application
 * submitted" cheapens the thing it is celebrating.
 */
export function SuccessCheck({
  className,
  size = 48,
}: {
  className?: string;
  size?: number;
}): React.ReactElement {
  const reduced = useReducedMotion();

  return (
    <span
      className={cn('relative inline-flex items-center justify-center text-xenon', className)}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <svg viewBox="0 0 52 52" className="size-full" fill="none">
        <motion.circle
          cx="26"
          cy="26"
          r="23"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray="145"
          initial={{ strokeDashoffset: 145 }}
          animate={{ strokeDashoffset: 0 }}
          transition={instant(reduced, { duration: duration.slow, ease: ease.emphasized })}
        />
        <motion.path
          d="M15 27.5 22.5 35 37.5 19"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray="36"
          initial={{ strokeDashoffset: 36 }}
          animate={{ strokeDashoffset: 0 }}
          transition={instant(reduced, {
            duration: duration.normal,
            delay: 0.28,
            ease: ease.standard,
          })}
        />
      </svg>
    </span>
  );
}

// --- Lists -------------------------------------------------------------------

/**
 * A list whose items enter and leave rather than appearing and vanishing.
 *
 * Wrap rows that are filtered, dismissed or arrive live - notifications, search
 * results, a review queue. Exits are shorter than entrances, which is what
 * makes a dismissal feel decisive instead of reluctant.
 */
export function AnimatedList({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={className}>
      <AnimatePresence initial={false}>{children}</AnimatePresence>
    </div>
  );
}

export function AnimatedListItem({
  children,
  className,
  layout = true,
}: {
  children: React.ReactNode;
  className?: string;
  /** Neighbours slide to close the gap. Turn off inside a virtualised list. */
  layout?: boolean;
}): React.ReactElement {
  const reduced = useReducedMotion();

  return (
    <motion.div
      // Layout animation is the one thing genuinely switched off rather than
      // shortened: it moves neighbouring rows, which is exactly the kind of
      // unrequested movement the preference exists to stop.
      layout={reduced === true ? false : layout}
      className={className}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{
        opacity: 0,
        y: -4,
        transition: instant(reduced, { duration: duration.fast, ease: ease.exit }),
      }}
      transition={instant(reduced, { duration: duration.normal, ease: ease.standard })}
    >
      {children}
    </motion.div>
  );
}

export { AnimatePresence };
