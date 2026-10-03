'use client';

import {
  motion,
  useMotionValue,
  useReducedMotion,
  useScroll,
  useTransform,
  type Variants,
} from 'motion/react';
import * as React from 'react';

import { cn } from '../lib/cn';

import { duration, ease, instant, staggerDelay } from './tokens';

/**
 * Entrance and media primitives.
 *
 * The rule the whole set follows: things arrive from a mask or from a short
 * lift, never from a long slide, and never twice. `once: true` is not a detail
 * - an element that replays every time it re-enters the viewport turns a long
 * page into a slot machine.
 *
 * ---
 *
 * How reduced motion is handled here, and why it is not the obvious way.
 *
 * The obvious way is to branch: if the viewer asked for reduced motion, render
 * a plain `<div>` instead of a `<motion.div>`. That is wrong, and it is wrong
 * in a way that only shows up for the people the branch was written for.
 *
 * These components render on the server, where the preference is unknowable -
 * `useReducedMotion()` can only answer in the browser. So the server renders
 * the animated markup, complete with the inline `opacity: 0` that Motion emits
 * for its initial state. A visitor with reduced motion set then hydrates the
 * *unanimated* markup over it, React finds a `<div>` where it expected a
 * `<div style="opacity:0">`, and logs a hydration mismatch. Their experience of
 * an accessibility preference is a console full of React errors and, depending
 * on where the mismatch lands, a subtree React re-creates from scratch.
 *
 * So: the element tree and the `initial` state are **identical** in both cases,
 * and only the transition changes. `instant()` collapses it to zero duration,
 * which means the element snaps to its final state the moment it qualifies -
 * no travel, no fade, nothing to trigger vestibular symptoms, and markup the
 * server and the browser agree on.
 *
 * Scroll-linked motion is the one case this cannot cover, because there the
 * movement is the value rather than the transition. `Parallax` zeroes its own
 * transform instead - same tree, same styles, no travel.
 */

type RevealElement = 'div' | 'section' | 'li' | 'article' | 'header' | 'span';

export interface RevealProps {
  children: React.ReactNode;
  className?: string;
  /** Seconds to wait once in view. Used to stagger siblings by hand. */
  delay?: number;
  /** Travel in pixels. Small by default: this is a lift, not a slide. */
  distance?: number;
  /** How much must be visible before it plays. */
  amount?: number;
  as?: RevealElement;
}

/** Fade and lift into view, once. */
export function Reveal({
  children,
  className,
  delay = 0,
  distance = 24,
  amount = 0.25,
  as = 'div',
}: RevealProps): React.ReactElement {
  const reduced = useReducedMotion();
  const Component = motion[as];

  return (
    <Component
      className={className}
      initial={{ opacity: 0, y: distance }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount }}
      transition={instant(reduced, { duration: duration.slow, delay, ease: ease.emphasized })}
    >
      {children}
    </Component>
  );
}

const staggerParent: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.06, delayChildren: 0.04 } },
};

const staggerParentInstant: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0, delayChildren: 0 } },
};

const staggerChild: Variants = {
  hidden: { opacity: 0, y: 18 },
  visible: { opacity: 1, y: 0 },
};

/**
 * Reveal children one after another. Pair with `StaggerItem`.
 *
 * The 60ms step is right for the six-to-eight item groups this is used on. For
 * a list that can be arbitrarily long, use `staggerDelay` from the tokens with
 * a plain `Reveal`, which compresses the step so twenty rows do not take a
 * second and a half.
 */
export function Stagger({
  children,
  className,
  amount = 0.2,
}: {
  children: React.ReactNode;
  className?: string;
  amount?: number;
}): React.ReactElement {
  const reduced = useReducedMotion();

  return (
    <motion.div
      className={className}
      variants={reduced === true ? staggerParentInstant : staggerParent}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount }}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  const reduced = useReducedMotion();

  return (
    <motion.div
      className={className}
      variants={staggerChild}
      transition={instant(reduced, { duration: duration.slow, ease: ease.emphasized })}
    >
      {children}
    </motion.div>
  );
}

/**
 * Masked line reveal for large headings.
 *
 * Each line sits in a clipping box and slides up from under it, which reads as
 * type being set rather than as text fading in. Splitting on an explicit array
 * of lines rather than on words keeps the editorial line breaks the designer
 * chose, at every viewport.
 */
export function TextReveal({
  lines,
  className,
  lineClassName,
  delay = 0,
}: {
  lines: readonly string[];
  className?: string;
  lineClassName?: string;
  delay?: number;
}): React.ReactElement {
  const reduced = useReducedMotion();

  return (
    <span className={cn('block', className)}>
      {lines.map((line, index) => (
        <span key={line} className="block overflow-hidden">
          <motion.span
            className={cn('block', lineClassName)}
            initial={{ y: '110%' }}
            animate={{ y: '0%' }}
            transition={instant(reduced, {
              duration: duration.cinematic,
              delay: delay + index * 0.09,
              ease: ease.emphasized,
            })}
          >
            {line}
          </motion.span>
        </span>
      ))}
    </span>
  );
}

/**
 * Variants shared by every masked reveal.
 *
 * Declared as variants rather than as `initial`/`whileInView` on the moving
 * element itself, and that is not a style choice - it is the only arrangement
 * that works.
 *
 * A masked reveal starts its content fully below a clipping box. An
 * `IntersectionObserver` measures an element *after* its ancestors' overflow
 * has clipped it, so a `whileInView` on the moving span sees an intersection
 * ratio of zero: the content cannot become visible until it moves, and it
 * cannot move until it is visible. The heading never arrives, and it fails
 * silently - no error, just a gap on the page where a headline should be.
 *
 * Putting the trigger on the clip wrapper breaks the cycle. The wrapper never
 * moves and is never clipped, so it intersects normally and drives its child
 * through variants.
 */
const maskVariants: Variants = {
  hidden: { y: '108%' },
  visible: { y: '0%' },
};

/**
 * Masked reveal for arbitrary content.
 *
 * `TextReveal` wants an array of strings so it can clip each line separately,
 * which is right for a hero headline and useless for a heading that already
 * contains markup - a `<br/>`, an emphasised span, a chrome gradient. This
 * clips the whole block instead and slides it up from underneath.
 *
 * Still a mask rather than a fade: content arriving from behind a hard edge is
 * what distinguishes a section heading being *set* from one turning up.
 */
export function MaskReveal({
  children,
  className,
  delay = 0,
  amount = 0.6,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  amount?: number;
}): React.ReactElement {
  const reduced = useReducedMotion();

  return (
    // The clip has a little headroom below it: descenders and the tail of a `g`
    // sit under the baseline, and a box clipped exactly to the line height
    // shaves them off at rest, not only during the animation.
    //
    // The trigger lives here, on the wrapper, for the reason `maskVariants`
    // explains: an observer on the moving child would never fire.
    <motion.span
      className={cn('block overflow-hidden pb-[0.12em]', className)}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount }}
    >
      <motion.span
        className="block"
        variants={maskVariants}
        transition={instant(reduced, { duration: duration.slow, delay, ease: ease.emphasized })}
      >
        {children}
      </motion.span>
    </motion.span>
  );
}

/**
 * Word-level masked reveal.
 *
 * For a single emphatic line where line-splitting is too coarse. Deliberately
 * not letter-level: animating each character individually is the cheesiest
 * thing on the web and it destroys the word shape a reader scans by.
 */
export function WordReveal({
  text,
  className,
  delay = 0,
}: {
  text: string;
  className?: string;
  delay?: number;
}): React.ReactElement {
  const reduced = useReducedMotion();
  const words = text.split(' ');

  return (
    // One trigger for the whole line, on an element that is never clipped -
    // see `maskVariants`. Each word's own wrapper does the clipping and its
    // span follows the parent's variant on a staggered delay.
    <motion.span
      className={cn('inline', className)}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.6 }}
    >
      {words.map((word, index) => (
        <span
          key={`${word}-${String(index)}`}
          className="inline-block overflow-hidden align-bottom"
        >
          <motion.span
            className="inline-block"
            variants={maskVariants}
            transition={instant(reduced, {
              duration: duration.slow,
              delay: delay + staggerDelay(index, words.length),
              ease: ease.emphasized,
            })}
          >
            {word}
            {index < words.length - 1 ? ' ' : null}
          </motion.span>
        </span>
      ))}
    </motion.span>
  );
}

/**
 * A hairline that draws itself across the viewport edge.
 *
 * The cheapest cinematic gesture in the system and the easiest to overuse: one
 * per section at most, and only where a divider was already wanted.
 */
export function AnimatedDivider({
  className,
  tone = 'line',
}: {
  className?: string;
  tone?: 'line' | 'accent' | 'chrome';
}): React.ReactElement {
  const reduced = useReducedMotion();
  const background = {
    line: 'bg-line-strong',
    accent: 'bg-xenon',
    chrome: 'bg-gradient-to-r from-chrome-500 via-chrome-300 to-transparent',
  }[tone];

  return (
    <motion.div
      aria-hidden
      className={cn('h-px w-full origin-left', background, className)}
      initial={{ scaleX: 0 }}
      whileInView={{ scaleX: 1 }}
      viewport={{ once: true, amount: 1 }}
      transition={instant(reduced, { duration: duration.slow, ease: ease.emphasized })}
    />
  );
}

/**
 * Scroll-linked parallax.
 *
 * Capped at a small fraction of the scroll distance. Heavy parallax on a
 * full-bleed image is the fastest way to make a page feel cheap and to drop
 * frames on a mid-range phone.
 *
 * The one primitive whose reduced-motion branch is a value rather than a
 * duration: the movement here *is* the scroll position, so there is no
 * transition to shorten. The transform is flattened to zero instead, which
 * leaves the markup identical and the image still.
 */
export function Parallax({
  children,
  className,
  strength = 0.15,
}: {
  children: React.ReactNode;
  className?: string;
  strength?: number;
}): React.ReactElement {
  const reduced = useReducedMotion();
  const ref = React.useRef<HTMLDivElement>(null);

  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ['start end', 'end start'],
  });

  const clamped = Math.min(Math.max(strength, 0), 0.4);

  /*
   * The preference is applied through a motion value, not through the rendered
   * transform.
   *
   * Zeroing `clamped` during render would change the element's very first
   * transform - `translateY(-8%)` on the server, `none` in a reduced-motion
   * browser - and that is a hydration mismatch in the markup, not just a
   * difference in behaviour. Multiplying by a motion value instead means both
   * sides render the identical style and the factor drops to zero immediately
   * afterwards, without a React render.
   */
  const factor = useMotionValue(1);

  React.useEffect(() => {
    factor.set(reduced === true ? 0 : 1);
  }, [reduced, factor]);

  const y = useTransform(
    [scrollYProgress, factor],
    ([progress, scale]: number[]) =>
      `${String(((progress ?? 0) - 0.5) * 2 * clamped * (scale ?? 1) * 100)}%`,
  );

  return (
    <div ref={ref} className={cn('relative overflow-hidden', className)}>
      <motion.div style={{ y }} className="size-full will-change-transform">
        {children}
      </motion.div>
    </div>
  );
}

/**
 * Cinematic media reveal.
 *
 * A dark cover retracts upward off the image while the image itself settles
 * from a 1.04 scale, and a single Xenon hairline travels with the cover edge.
 * That hairline is the house motif: the same gesture marks a loading rail, an
 * active card and a verified link, so a media reveal reads as part of the same
 * machine rather than as a stock fade.
 *
 * Both animated properties are transforms on composited layers. The wrapper
 * clips, so nothing escapes its box.
 */
export function MediaReveal({
  children,
  className,
  delay = 0,
  /** Turn off the travelling hairline for secondary or repeated media. */
  scanLine = true,
  /**
   * Seconds for the cover to retract.
   *
   * The default is the house cinematic beat. Raising it is how a section gets a
   * different temperature - the underworld block runs at nearly double, so its
   * media surfaces out of the black rather than opening onto it.
   */
  seconds = duration.cinematic,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  scanLine?: boolean;
  seconds?: number;
}): React.ReactElement {
  const reduced = useReducedMotion();

  return (
    <motion.div
      className={cn('relative overflow-hidden', className)}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.3 }}
    >
      <motion.div
        className="size-full"
        variants={{
          hidden: { scale: 1.04, opacity: 0.4 },
          visible: { scale: 1, opacity: 1 },
        }}
        transition={instant(reduced, { duration: seconds, delay, ease: ease.emphasized })}
      >
        {children}
      </motion.div>

      <motion.span
        aria-hidden
        className="pointer-events-none absolute inset-0 origin-top bg-void"
        variants={{ hidden: { scaleY: 1 }, visible: { scaleY: 0 } }}
        transition={instant(reduced, { duration: seconds * 0.85, delay, ease: ease.emphasized })}
      >
        {scanLine ? (
          <span className="absolute inset-x-0 bottom-0 h-px bg-xenon/70 shadow-[0_0_12px_2px_#2afd2366]" />
        ) : null}
      </motion.span>
    </motion.div>
  );
}

/**
 * Very slow scale on a still image.
 *
 * 1.06 to 1.00 over half a minute - below the threshold at which anyone
 * consciously notices, which is exactly the point. A still hero that is
 * perfectly static reads as a screenshot; this reads as a held shot.
 *
 * CSS rather than Motion: it is a single keyframe that runs once and must not
 * hold a JavaScript animation frame open for thirty seconds. Reduced motion is
 * handled by the blanket rule in the base stylesheet.
 */
export function KenBurns({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return <div className={cn('x-ken-burns size-full', className)}>{children}</div>;
}
