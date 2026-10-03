'use client';

import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '../lib/cn';

/**
 * The small, high-traffic pieces: panels, badges, eyebrows, dividers, dots.
 *
 * Grouped in one file because they are two dozen lines each and splitting them
 * would mean twenty imports at every call site for no isolation benefit.
 */

// --- Panel -------------------------------------------------------------------

const panelVariants = cva('relative', {
  variants: {
    tone: {
      flat: 'bg-surface border border-line',
      raised: 'bg-elevated border border-line-strong shadow-panel',
      sunken: 'bg-black border border-line',
      ghost: 'bg-transparent border border-line',
      accent: 'bg-xenon-deep/20 border border-xenon/30',
    },
    radius: { none: '', sm: 'rounded-sm', md: 'rounded-md', lg: 'rounded-lg', xl: 'rounded-xl' },
    pad: { none: '', sm: 'p-3', md: 'p-5', lg: 'p-7', xl: 'p-10' },
  },
  defaultVariants: { tone: 'flat', radius: 'lg', pad: 'md' },
});

export interface PanelProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof panelVariants> {
  /** Adds the hairline top highlight that gives dark panels their edge. */
  edgeLight?: boolean;
}

export const Panel = React.forwardRef<HTMLDivElement, PanelProps>(function Panel(
  { className, tone, radius, pad, edgeLight = false, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        panelVariants({ tone, radius, pad }),
        edgeLight && 'x-edge-light overflow-hidden',
        className,
      )}
      {...props}
    />
  );
});

// --- Badge -------------------------------------------------------------------

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[0.6875rem] font-medium uppercase tracking-[0.1em] whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'border-line-strong bg-elevated text-ink-secondary',
        success: 'border-xenon/35 bg-xenon/10 text-xenon',
        danger: 'border-danger/35 bg-danger/10 text-danger',
        warning: 'border-warning/35 bg-warning/10 text-warning',
        info: 'border-info/35 bg-info/10 text-info',
        progress: 'border-info/35 bg-info/10 text-info',
        attention: 'border-warning/35 bg-warning/10 text-warning',
        chrome: 'border-chrome-500 bg-raised text-chrome-200',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps): React.ReactElement {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

// --- Status dot --------------------------------------------------------------

export type StatusTone = 'online' | 'offline' | 'degraded' | 'checking' | 'unknown';

const dotColour: Record<StatusTone, string> = {
  online: 'bg-xenon',
  offline: 'bg-danger',
  degraded: 'bg-warning',
  checking: 'bg-chrome-300',
  unknown: 'bg-chrome-400',
};

/**
 * Live-state dot.
 *
 * Only `online` gets the expanding ring, and `.x-status-ring` is deliberately
 * slower and fainter than Tailwind's `animate-ping`, which at its default
 * cadence reads as a hazard light. A pulsing red would read as an emergency,
 * `checking` should read as busy rather than as an alarm, and `unknown` should
 * look inert because that is exactly what it is.
 *
 * The colour is transitioned rather than swapped, so a poll that flips UNKNOWN
 * to ONLINE reads as the city coming up rather than as a repaint. CSS only -
 * this appears on server-rendered status pages and should not drag an
 * animation runtime into them.
 */
export function StatusDot({
  state,
  className,
}: {
  state: StatusTone;
  className?: string;
}): React.ReactElement {
  return (
    <span className={cn('relative flex size-2 shrink-0', className)} aria-hidden>
      {state === 'online' ? (
        <span className="x-status-ring absolute inset-0 rounded-full bg-xenon" />
      ) : null}
      {state === 'checking' ? (
        <span className="absolute inset-0 animate-pulse rounded-full bg-chrome-300/50" />
      ) : null}
      <span
        className={cn(
          'relative inline-flex size-full rounded-full transition-colors duration-(--duration-base) ease-standard',
          dotColour[state],
        )}
      />
    </span>
  );
}

// --- Eyebrow -----------------------------------------------------------------

export function Eyebrow({
  children,
  className,
  accent = false,
}: {
  children: React.ReactNode;
  className?: string;
  accent?: boolean;
}): React.ReactElement {
  return (
    <p className={cn('x-eyebrow', accent && 'text-xenon', className)}>
      {accent ? <span className="mr-2 inline-block h-px w-6 bg-xenon align-middle" /> : null}
      {children}
    </p>
  );
}

// --- Separator ---------------------------------------------------------------

export function Separator({
  className,
  orientation = 'horizontal',
  decorative = true,
}: {
  className?: string;
  orientation?: 'horizontal' | 'vertical';
  decorative?: boolean;
}): React.ReactElement {
  return (
    <div
      role={decorative ? 'none' : 'separator'}
      aria-orientation={decorative ? undefined : orientation}
      className={cn(
        'bg-line',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
    />
  );
}

// --- Skeleton ----------------------------------------------------------------

/**
 * Loading placeholder.
 *
 * Sized by the caller to match the content it stands in for, so the layout
 * does not shift when real data arrives - a skeleton that is the wrong height
 * is worse than no skeleton at all.
 *
 * The shimmer is a low-contrast highlight crossing a dark surface, not the
 * bright white sweep every component library ships: on this palette that reads
 * as a strobe. See `.x-skeleton` in theme.css.
 */
export function Skeleton({ className }: { className?: string }): React.ReactElement {
  return <div className={cn('x-skeleton rounded-sm', className)} aria-hidden />;
}

/**
 * Lines of placeholder text.
 *
 * The last line is short, because real paragraphs end mid-measure and a block
 * of equal-length bars reads as a barcode rather than as prose.
 */
export function SkeletonText({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn('flex flex-col gap-2', className)} aria-hidden>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          className={cn(
            'h-3',
            index === lines - 1 ? 'w-2/5' : index % 3 === 1 ? 'w-full' : 'w-11/12',
          )}
        />
      ))}
    </div>
  );
}

/**
 * Placeholder rows that keep a table's shape.
 *
 * A centred spinner over an empty region throws the layout away and then
 * throws it back, which is the flicker skeletons exist to prevent. These
 * render inside the real `<tbody>` with the real column count, so the header
 * stays put and the rows arrive in place.
 *
 * Column widths vary deliberately: identical bars in every cell look like a
 * rendering fault, and a first column that is wider reads as a name field.
 */
export function SkeletonRows({
  rows = 6,
  columns = 4,
  className,
}: {
  rows?: number;
  columns?: number;
  className?: string;
}): React.ReactElement {
  const widths = ['w-32', 'w-20', 'w-24', 'w-16', 'w-28'];

  return (
    <>
      {Array.from({ length: rows }, (_, row) => (
        <tr key={row} className={cn('border-b border-line', className)}>
          {Array.from({ length: columns }, (_, column) => (
            // Same padding as `TD`, so the placeholder rows are exactly the
            // height the real ones will be and nothing shifts on arrival.
            <td key={column} className="px-3 py-2.5">
              <Skeleton className={cn('h-3.5', widths[(row + column) % widths.length] ?? 'w-24')} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

// --- Empty state -------------------------------------------------------------

/**
 * Nothing to show, said deliberately.
 *
 * Fades and lifts on mount rather than appearing, which matters most where an
 * empty state is the *result* of something - a filter that matched nothing, a
 * search with no hits. Snapping a "nothing here" panel into the space a list
 * occupied a moment ago reads as the page breaking; arriving reads as an
 * answer.
 *
 * CSS rather than Motion: it plays once, on mount, and has no exit.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div
      className={cn(
        'flex animate-slide-up flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-line-strong px-6 py-16 text-center',
        className,
      )}
    >
      {icon === undefined ? null : <div className="text-chrome-400">{icon}</div>}
      <p className="font-display text-lg font-semibold text-ink">{title}</p>
      {description === undefined ? null : (
        <p className="max-w-sm text-sm text-ink-muted">{description}</p>
      )}
      {action === undefined ? null : <div className="mt-2">{action}</div>}
    </div>
  );
}

// --- Avatar ------------------------------------------------------------------

/**
 * Avatar with an initials fallback.
 *
 * Deliberately not `next/image`: these are small, come from a third-party CDN
 * whose host list would have to be whitelisted, and are frequently missing.
 * A plain `img` with a fallback is the smaller correct answer.
 */
export function Avatar({
  src,
  name,
  size = 32,
  className,
}: {
  src?: string | null;
  name?: string | null;
  size?: number;
  className?: string;
}): React.ReactElement {
  const initials = (name ?? '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-line-strong bg-elevated text-ink-secondary',
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.38) }}
    >
      {src == null || src === '' ? (
        <span className="font-medium">{initials}</span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- remote avatar host, see note above
        <img src={src} alt="" width={size} height={size} className="size-full object-cover" />
      )}
    </span>
  );
}

export { badgeVariants, panelVariants };
