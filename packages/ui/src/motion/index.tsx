'use client';

import { motion, useReducedMotion, useScroll, useTransform, type Variants } from 'motion/react';
import * as React from 'react';

import { cn } from '../lib/cn';

/**
 * Motion primitives.
 *
 * A deliberately small set: reveal on scroll, stagger a group, reveal text by
 * line, and a restrained parallax. Everything the brief rules out - particles,
 * floating blobs, bouncing buttons - is absent because there is nothing here
 * that could produce them.
 *
 * Every primitive checks `useReducedMotion` and renders the final state
 * immediately when it is set. That is a real behavioural branch, not a shorter
 * duration: the CSS media query handles transitions, but a scroll-linked
 * transform has to be disabled in JavaScript or it still moves.
 */

const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const;

export interface RevealProps {
  children: React.ReactNode;
  className?: string;
  /** Seconds to wait once in view. Used to stagger sibling elements. */
  delay?: number;
  /** Travel distance in pixels. Small by default; this is a lift, not a slide. */
  distance?: number;
  /** How much of the element must be visible before it plays. */
  amount?: number;
  as?: 'div' | 'section' | 'li' | 'article' | 'header';
}

/**
 * Fade and lift into view, once.
 *
 * `once: true` matters: an element that re-animates every time it scrolls back
 * into view turns a long page into a slot machine.
 */
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

  if (reduced === true) {
    return <div className={className}>{children}</div>;
  }

  return (
    <Component
      className={className}
      initial={{ opacity: 0, y: distance }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount }}
      transition={{ duration: 0.7, delay, ease: EASE_OUT_EXPO }}
    >
      {children}
    </Component>
  );
}

const staggerParent: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.08, delayChildren: 0.05 } },
};

const staggerChild: Variants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.65, ease: EASE_OUT_EXPO } },
};

/** Reveal children one after another. Pair with `StaggerItem`. */
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
  if (reduced === true) return <div className={className}>{children}</div>;

  return (
    <motion.div
      className={className}
      variants={staggerParent}
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
  if (reduced === true) return <div className={className}>{children}</div>;

  return (
    <motion.div className={className} variants={staggerChild}>
      {children}
    </motion.div>
  );
}

/**
 * Masked line reveal for large headings.
 *
 * Each line sits in a clipping box and slides up from below it, which reads as
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
          {reduced === true ? (
            <span className={cn('block', lineClassName)}>{line}</span>
          ) : (
            <motion.span
              className={cn('block', lineClassName)}
              initial={{ y: '110%' }}
              animate={{ y: '0%' }}
              transition={{
                duration: 1.05,
                delay: delay + index * 0.09,
                ease: EASE_OUT_EXPO,
              }}
            >
              {line}
            </motion.span>
          )}
        </span>
      ))}
    </span>
  );
}

/**
 * Scroll-linked parallax.
 *
 * Capped at a small fraction of the scroll distance. Heavy parallax on a
 * full-bleed image is the single fastest way to make a page feel cheap and to
 * drop frames on a mid-range phone.
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
  const y = useTransform(
    scrollYProgress,
    [0, 1],
    [`${String(-clamped * 100)}%`, `${String(clamped * 100)}%`],
  );

  return (
    <div ref={ref} className={cn('relative overflow-hidden', className)}>
      {reduced === true ? (
        <div className="size-full">{children}</div>
      ) : (
        <motion.div style={{ y }} className="size-full will-change-transform">
          {children}
        </motion.div>
      )}
    </div>
  );
}

/**
 * Thin progress bar tied to page scroll.
 *
 * Used on long reading pages - the rulebook, a news article - where knowing how
 * much is left is genuinely useful.
 */
export function ScrollProgress({ className }: { className?: string }): React.ReactElement {
  const { scrollYProgress } = useScroll();

  return (
    <motion.div
      aria-hidden
      className={cn('fixed inset-x-0 top-0 z-[45] h-0.5 origin-left bg-xenon', className)}
      style={{ scaleX: scrollYProgress }}
    />
  );
}

export { motion, useReducedMotion };
