'use client';

import { Check, Lock } from 'lucide-react';
import { motion, useReducedMotion, useScroll, useSpring } from 'motion/react';
import * as React from 'react';

import { cn } from '../lib/cn';

import { duration, ease, instant } from './tokens';

/**
 * The Xenon progress language.
 *
 * Three kinds of indicator, and which one is correct is decided by what is
 * actually known - never by what looks best:
 *
 *  - `ProgressBar`, `SegmentedProgress`, `StepProgress` and `ProgressRing`
 *    state a real fraction. Form completion, onboarding steps, scroll
 *    position. The number they show is computed from the thing itself.
 *  - `LoadingRail` and `Spinner` state that something is happening and refuse
 *    to guess how far along it is. Navigation, a server action, an OAuth round
 *    trip.
 *  - Nothing here animates decoratively in a way that could be read as
 *    operational progress. A rail that travels forever is visibly a loop; a
 *    fill that sits at 67% means sixty-seven percent.
 *
 * Shared visual language: a recessed dark track, a green fill, and a single
 * point of light at the leading edge. The glow is on the edge only - a bar that
 * glows along its whole length reads as decoration and washes out at 2px.
 */

// --- Determinate -------------------------------------------------------------

export type ProgressSize = 'thin' | 'default' | 'large';
export type ProgressTone = 'accent' | 'chrome' | 'warning' | 'danger';

const trackHeight: Record<ProgressSize, string> = {
  thin: 'h-0.5',
  default: 'h-1',
  large: 'h-2',
};

const fillTone: Record<ProgressTone, string> = {
  accent: 'bg-xenon',
  chrome: 'bg-chrome-300',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

/** Percentage of `max`, clamped, and 0 for the nonsense cases. */
export function clampPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(100, Math.max(0, (value / max) * 100));
}

export interface ProgressBarProps {
  /** Completed units. Must be a real measurement, never an estimate. */
  value: number;
  max?: number;
  size?: ProgressSize;
  tone?: ProgressTone;
  className?: string;
  /** Required unless the bar sits directly beneath its own visible label. */
  label?: string;
  /** Drops the leading-edge light. Use inside dense tables. */
  flat?: boolean;
}

/**
 * A measured fill.
 *
 * Animates width rather than a transform: the track is a hard container and a
 * scaled child smears its leading edge. There are never many of these on screen
 * at once, so this is not the animation that costs frames.
 */
export function ProgressBar({
  value,
  max = 100,
  size = 'default',
  tone = 'accent',
  className,
  label,
  flat = false,
}: ProgressBarProps): React.ReactElement {
  const percent = clampPercent(value, max);
  const complete = percent >= 100;

  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={cn(
        'relative w-full overflow-hidden rounded-pill bg-black',
        trackHeight[size],
        className,
      )}
    >
      <div
        className={cn(
          'relative h-full rounded-pill transition-[width] duration-(--duration-base) ease-standard',
          fillTone[tone],
          complete && tone === 'accent' && 'x-progress-complete',
        )}
        style={{ width: `${String(percent)}%` }}
      >
        {/* Leading-edge light, suppressed at both extremes: there is no edge to
            light at zero, and at 100% the glow would hang off the track. */}
        {flat || percent <= 0 || complete ? null : (
          <span
            aria-hidden
            className="absolute inset-y-0 right-0 w-4 rounded-pill bg-gradient-to-r from-transparent to-white/45"
          />
        )}
      </div>
    </div>
  );
}

/**
 * A fill split into discrete units.
 *
 * Right when the thing being measured genuinely has units - six form sections,
 * four onboarding steps - because "four of six" is legible at a glance in a way
 * a 67% bar is not.
 */
export function SegmentedProgress({
  value,
  total,
  size = 'default',
  className,
  label,
}: {
  value: number;
  total: number;
  size?: ProgressSize;
  className?: string;
  label?: string;
}): React.ReactElement {
  const reduced = useReducedMotion();
  const filled = Math.min(Math.max(Math.round(value), 0), total);

  return (
    <div
      role="progressbar"
      aria-valuenow={filled}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-label={label}
      className={cn('flex w-full gap-1', className)}
    >
      {Array.from({ length: Math.max(total, 1) }, (_, index) => (
        <span
          key={index}
          className={cn('flex-1 overflow-hidden rounded-pill bg-black', trackHeight[size])}
        >
          <motion.span
            className="block h-full origin-left rounded-pill bg-xenon"
            initial={false}
            animate={{ scaleX: index < filled ? 1 : 0 }}
            transition={
              reduced === true
                ? { duration: 0 }
                : // Later segments settle fractionally after earlier ones, so a
                  // jump of three reads as filling rather than as a repaint.
                  { duration: duration.normal, delay: index * 0.05, ease: ease.standard }
            }
          />
        </span>
      ))}
    </div>
  );
}

// --- Steps -------------------------------------------------------------------

export type StepState = 'complete' | 'active' | 'pending' | 'locked';

export interface JourneyStep {
  readonly key: string;
  readonly label: string;
  readonly state: StepState;
  readonly hint?: string;
}

/**
 * A connected journey.
 *
 * DISCORD ━━ RULES ━━ FIVEM ━━ WHITELIST, with the rail filling up to the
 * current node. The rail is the point: separate ticks say "four tasks", a
 * filling rail says "you are here, and this is what is left".
 */
export function StepProgress({
  steps,
  orientation = 'horizontal',
  className,
  label,
}: {
  steps: readonly JourneyStep[];
  orientation?: 'horizontal' | 'vertical';
  className?: string;
  label?: string;
}): React.ReactElement {
  const reduced = useReducedMotion();
  const horizontal = orientation === 'horizontal';

  const done = steps.filter((step) => step.state === 'complete').length;
  const active = steps.findIndex((step) => step.state === 'active');
  // The rail reaches the active node, or the last completed one when nothing is
  // in progress. Never beyond: the line must not promise a step not reached.
  const reached = active >= 0 ? active : Math.max(done - 1, 0);
  const fill = steps.length <= 1 ? 0 : reached / (steps.length - 1);

  return (
    <ol
      aria-label={label}
      className={cn(
        'relative',
        horizontal ? 'flex items-start justify-between gap-2' : 'flex flex-col',
        className,
      )}
    >
      {/*
        The rail sits behind the nodes, inset by half a step so it runs between
        the first and last node centres rather than out to the edges of the row.

        The inset is an inline style rather than an arbitrary Tailwind value:
        `left-[calc(50%/6)]` looks reasonable and does not work, because Tailwind
        reads the slash in an arbitrary value as the opacity modifier and the
        class is silently dropped. The symptom is a rail that overshoots both
        ends by half a node, which looks like a design choice rather than a bug.
      */}
      <span
        aria-hidden
        className={cn(
          'absolute bg-line',
          horizontal ? 'top-2.5 h-px' : 'top-3 bottom-6 left-2.5 w-px',
        )}
        style={
          horizontal
            ? { left: `${String(50 / steps.length)}%`, right: `${String(50 / steps.length)}%` }
            : undefined
        }
      >
        <motion.span
          className={cn('block size-full bg-xenon', horizontal ? 'origin-left' : 'origin-top')}
          initial={false}
          animate={horizontal ? { scaleX: fill } : { scaleY: fill }}
          transition={
            reduced === true ? { duration: 0 } : { duration: duration.slow, ease: ease.emphasized }
          }
        />
      </span>

      {steps.map((step) => (
        <li
          key={step.key}
          aria-current={step.state === 'active' ? 'step' : undefined}
          className={cn(
            'relative z-1',
            horizontal
              ? 'flex min-w-0 flex-1 flex-col items-center gap-2 text-center'
              : 'flex items-start gap-3 pb-6 last:pb-0',
          )}
        >
          <StepNode state={step.state} />
          <div className={cn('min-w-0', horizontal ? '' : 'flex-1 pt-0.5')}>
            <p
              className={cn(
                'font-mono text-[0.625rem] tracking-[0.16em] uppercase transition-colors duration-(--duration-base)',
                step.state === 'complete' && 'text-ink',
                step.state === 'active' && 'text-xenon',
                step.state === 'pending' && 'text-ink-secondary',
                step.state === 'locked' && 'text-ink-muted/60',
              )}
            >
              {step.label}
            </p>
            {step.hint === undefined ? null : (
              <p className="mt-1 text-xs text-ink-muted">{step.hint}</p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function StepNode({ state }: { state: StepState }): React.ReactElement {
  const reduced = useReducedMotion();

  return (
    <span
      aria-hidden
      className={cn(
        'relative flex size-5 shrink-0 items-center justify-center rounded-full border bg-void transition-colors duration-(--duration-base)',
        state === 'complete' && 'border-xenon bg-xenon text-ink-inverse',
        state === 'active' && 'border-xenon text-xenon',
        state === 'pending' && 'border-line-strong text-ink-muted',
        state === 'locked' && 'border-line text-ink-muted/50',
      )}
    >
      {state === 'complete' ? (
        <motion.span
          initial={{ scale: 0.4, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={instant(reduced, { duration: duration.fast, ease: ease.emphasized })}
        >
          <Check className="size-3" strokeWidth={3.5} />
        </motion.span>
      ) : state === 'active' ? (
        <>
          <span className="size-1.5 rounded-full bg-xenon" />
          {/* The one continuous loop in this file, and it marks the single node
              the player is actually being asked to act on. */}
          <span className="absolute inset-0 animate-ping rounded-full bg-xenon/30 motion-reduce:hidden" />
        </>
      ) : state === 'locked' ? (
        <Lock className="size-2.5" />
      ) : (
        <span className="size-1.5 rounded-full bg-current" />
      )}
    </span>
  );
}

// --- Ring --------------------------------------------------------------------

/**
 * A ring, for a single headline completeness figure.
 *
 * Used sparingly. A ring is harder to read at a glance than a bar, so it earns
 * its place only where the figure is the subject rather than an accompaniment.
 */
export function ProgressRing({
  value,
  max = 100,
  size = 72,
  stroke = 4,
  className,
  label,
  children,
}: {
  value: number;
  max?: number;
  size?: number;
  stroke?: number;
  className?: string;
  label?: string;
  children?: React.ReactNode;
}): React.ReactElement {
  const reduced = useReducedMotion();
  const percent = clampPercent(value, max);
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={cn('relative inline-flex items-center justify-center', className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--color-line)"
          strokeWidth={stroke}
        />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--color-xenon)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: circumference * (1 - percent / 100) }}
          transition={
            reduced === true
              ? { duration: 0 }
              : { duration: duration.cinematic * 0.8, ease: ease.emphasized }
          }
        />
      </svg>
      {children === undefined ? null : (
        <span className="absolute inset-0 flex items-center justify-center">{children}</span>
      )}
    </div>
  );
}

// --- Indeterminate -----------------------------------------------------------

/**
 * A travelling segment on a dark rail.
 *
 * The house loader. It says "working" and, unlike a percentage, cannot be
 * wrong. Pure CSS: one transform on one element, so a dozen of them across a
 * dashboard cost nothing.
 *
 * Mount it only while something is genuinely in flight. A rail that is always
 * there is furniture, and furniture is ignored.
 */
export function LoadingRail({
  className,
  size = 'thin',
  label = 'Loading',
}: {
  className?: string;
  size?: ProgressSize;
  label?: string;
}): React.ReactElement {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-busy="true"
      className={cn(
        'relative w-full overflow-hidden rounded-pill bg-black',
        trackHeight[size],
        className,
      )}
    >
      <span aria-hidden className="x-rail-travel absolute inset-y-0 w-2/5 rounded-pill bg-xenon" />
    </div>
  );
}

/**
 * The compact circular loader.
 *
 * Kept for buttons and icon-sized slots, where a rail has nowhere to travel.
 * Anywhere with room, use `LoadingRail`.
 */
export function Spinner({
  className,
  label = 'Loading',
}: {
  className?: string;
  label?: string;
}): React.ReactElement {
  return (
    <span role="status" aria-label={label} className={cn('inline-flex size-4', className)}>
      <svg viewBox="0 0 24 24" fill="none" className="size-full animate-spin" aria-hidden>
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.18" />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

// --- Scroll ------------------------------------------------------------------

/**
 * Reading position for a long page.
 *
 * Genuinely determinate - it is scroll position, measured - and useful only
 * where there is enough to read that "how much is left" is a real question.
 * Spring-smoothed so a trackpad flick does not make it twitch.
 */
export function ScrollProgress({
  className,
  target,
}: {
  className?: string;
  /** Measure this element instead of the whole document. */
  target?: React.RefObject<HTMLElement | null>;
}): React.ReactElement {
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll(
    target === undefined ? undefined : { target, offset: ['start start', 'end end'] },
  );
  const smoothed = useSpring(scrollYProgress, { stiffness: 260, damping: 40, restDelta: 0.001 });

  return (
    <motion.div
      aria-hidden
      className={cn(
        'pointer-events-none fixed inset-x-0 top-0 z-45 h-0.5 origin-left bg-xenon',
        className,
      )}
      style={{ scaleX: reduced === true ? scrollYProgress : smoothed }}
    />
  );
}
