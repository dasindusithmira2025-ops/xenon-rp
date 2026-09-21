import { cn } from '@xenon/ui';

/**
 * The Xenon mark and wordmark.
 *
 * Drawn as inline SVG rather than loaded as a file: it is small, it needs to
 * inherit colour from its context (chrome in the header, green on a dark
 * panel), and an inline mark cannot produce a broken-image frame in the one
 * place a broken image would be most visible.
 *
 * REPLACEABLE ASSET. This is a faithful construction from the brand direction -
 * an angular X cut from chrome with a xenon-green edge - and is intended to be
 * swapped for the community's official logo file. Everything that renders the
 * logo goes through these two components, so that swap is one edit.
 */

export function XenonMark({
  className,
  title,
}: {
  className?: string;
  title?: string;
}): React.ReactElement {
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn('size-7', className)}
      role={title === undefined ? 'presentation' : 'img'}
      aria-label={title}
      aria-hidden={title === undefined}
    >
      <defs>
        <linearGradient id="xenon-chrome" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#E8EDE8" />
          <stop offset="42%" stopColor="#C8CFC8" />
          <stop offset="62%" stopColor="#6E766E" />
          <stop offset="100%" stopColor="#C8CFC8" />
        </linearGradient>
      </defs>

      {/* The X, cut as two hard strokes rather than a typeface glyph so it
          stays crisp at 20px in the header. */}
      <path
        d="M4 3h6.6l5.4 8.1L21.4 3H28l-8.7 12.9L28 29h-6.6L16 20.6 10.6 29H4l8.7-13.1Z"
        fill="url(#xenon-chrome)"
      />
      {/* Accent edge: the single green element in the mark. */}
      <path d="M4 3h6.6l1.4 2.1H5.4Z" fill="#2AFD23" />
    </svg>
  );
}

export function Wordmark({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}): React.ReactElement {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <XenonMark className="size-6" />
      <span className="font-display text-base leading-none font-extrabold tracking-[0.14em] text-ink">
        XENON
        {compact ? null : (
          <span className="ml-1.5 font-mono text-[0.625rem] font-normal tracking-[0.2em] text-ink-muted">
            RP
          </span>
        )}
      </span>
    </span>
  );
}
