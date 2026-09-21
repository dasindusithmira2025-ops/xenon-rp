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

export type StatusTone = 'online' | 'offline' | 'degraded' | 'unknown';

const dotColour: Record<StatusTone, string> = {
  online: 'bg-xenon',
  offline: 'bg-danger',
  degraded: 'bg-warning',
  unknown: 'bg-chrome-400',
};

/**
 * Live-state dot.
 *
 * Only the online state pulses. A pulsing red would read as an emergency, and
 * an unknown state should look inert because that is exactly what it is.
 */
export function StatusDot({
  state,
  className,
}: {
  state: StatusTone;
  className?: string;
}): React.ReactElement {
  return (
    <span className={cn('relative flex size-2', className)} aria-hidden>
      {state === 'online' ? (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-xenon opacity-60 motion-reduce:hidden" />
      ) : null}
      <span className={cn('relative inline-flex size-2 rounded-full', dotColour[state])} />
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
 */
export function Skeleton({ className }: { className?: string }): React.ReactElement {
  return (
    <div
      className={cn('animate-pulse rounded-sm bg-elevated motion-reduce:animate-none', className)}
      aria-hidden
    />
  );
}

// --- Empty state -------------------------------------------------------------

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
        'flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-line-strong px-6 py-16 text-center',
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

// --- Progress ----------------------------------------------------------------

export function Progress({
  value,
  max = 100,
  className,
  label,
}: {
  value: number;
  max?: number;
  className?: string;
  label?: string;
}): React.ReactElement {
  const percent = max === 0 ? 0 : Math.min(100, Math.max(0, (value / max) * 100));

  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={cn('h-1 w-full overflow-hidden rounded-pill bg-elevated', className)}
    >
      <div
        className="h-full rounded-pill bg-xenon transition-[width] duration-(--duration-base) ease-standard"
        style={{ width: `${String(percent)}%` }}
      />
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
