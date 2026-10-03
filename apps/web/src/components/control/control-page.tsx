import Link from 'next/link';

import { cn } from '@xenon/ui';
import { AnimatedCounter, LoadingRail } from '@xenon/ui/motion';

/**
 * Control centre page scaffolding.
 *
 * Dense by design. A narrow reading measure is right for the public site and
 * wrong here, where the job is comparing rows - so these pages run to the full
 * width with a tight vertical rhythm.
 */
export function ControlPage({
  title,
  lead,
  actions,
  breadcrumb,
  children,
  className,
  loading = false,
}: {
  title: string;
  lead?: string;
  actions?: React.ReactNode;
  breadcrumb?: { href: string; label: string };
  children: React.ReactNode;
  className?: string;
  /**
   * Draw the refresh rail under the heading.
   *
   * For screens that reload their own data in place. Pass a real pending flag -
   * this must never be left on as decoration, because a rail that is always
   * there stops meaning anything and the next genuine wait goes unnoticed.
   */
  loading?: boolean;
}): React.ReactElement {
  return (
    <div className={cn('flex flex-col gap-6 p-5 lg:p-8', className)}>
      <header className="flex flex-col gap-3">
        {breadcrumb === undefined ? null : (
          <Link
            href={breadcrumb.href}
            className="font-mono text-[0.625rem] tracking-[0.16em] text-ink-muted uppercase transition-colors hover:text-xenon"
          >
            ← {breadcrumb.label}
          </Link>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-1.5">
            <h1 className="font-display text-2xl font-bold tracking-tight text-ink">{title}</h1>
            {lead === undefined ? null : <p className="max-w-3xl text-sm text-ink-muted">{lead}</p>}
          </div>
          {actions === undefined ? null : (
            <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>
          )}
        </div>

        {loading ? <LoadingRail label={`Refreshing ${title.toLowerCase()}`} /> : null}
      </header>

      {children}
    </div>
  );
}

/** A compact metric tile for the overview and the section headers. */
export function MetricTile({
  label,
  value,
  hint,
  href,
  tone = 'neutral',
}: {
  label: string;
  value: string | number;
  hint?: string;
  href?: string;
  tone?: 'neutral' | 'accent' | 'warn' | 'danger';
}): React.ReactElement {
  const toneClass = {
    neutral: 'text-ink',
    accent: 'text-xenon',
    warn: 'text-warning',
    danger: 'text-danger',
  }[tone];

  const body = (
    <>
      <p className="x-eyebrow">{label}</p>
      <p className={cn('x-tabular font-display text-3xl leading-none font-black', toneClass)}>
        {/*
          Numeric metrics count in; anything else is set as-is.
          `countOnReveal` is off deliberately: these tiles are above the fold on
          a page staff reload all day, and a dashboard that re-runs every figure
          from zero on every visit is a slot machine, not an instrument. They
          animate when a value genuinely changes and are otherwise still.
        */}
        {typeof value === 'number' ? (
          <AnimatedCounter value={value} countOnReveal={false} />
        ) : (
          value
        )}
      </p>
      {hint === undefined ? null : <p className="text-xs text-ink-muted">{hint}</p>}
    </>
  );

  const classes =
    'flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-5 transition-colors duration-(--duration-fast)';

  return href === undefined ? (
    <div className={classes}>{body}</div>
  ) : (
    <Link href={href} className={cn(classes, 'hover:border-chrome-500')}>
      {body}
    </Link>
  );
}
