import Image from 'next/image';

import { cn } from '@xenon/ui';

import { isDevelopment } from '~/lib/env';

/**
 * A replaceable media surface.
 *
 * The site is designed around cinematic photography that the community owns and
 * that this repository deliberately does not ship - committing stock or, worse,
 * someone else's screenshots to fill a hero is how a project acquires a
 * licensing problem.
 *
 * So every image position is a slot. Given a URL it renders a properly sized,
 * lazily loaded image. Given nothing it renders a composed abstract panel built
 * from the brand's own tokens - layered chrome gradients, a fine grid, a single
 * green edge - which is a deliberate treatment rather than a grey box with a
 * cross through it.
 *
 * Each slot names itself in development so an operator can see at a glance
 * which asset they still owe. That label never renders in production.
 */

export interface MediaSlotProps {
  /** Configured asset URL. Null renders the designed fallback. */
  src?: string | null;
  alt: string;
  /** Short identifier shown in development, e.g. `home.hero`. */
  slot: string;
  className?: string;
  /** Above-the-fold images should set this; everything else stays lazy. */
  priority?: boolean;
  sizes?: string;
  /** Deterministic variation so adjacent fallbacks do not look identical. */
  seed?: number;
  children?: React.ReactNode;
}

export function MediaSlot({
  src,
  alt,
  slot,
  className,
  priority = false,
  sizes = '100vw',
  seed = 0,
  children,
}: MediaSlotProps): React.ReactElement {
  if (src != null && src.length > 0) {
    return (
      <div className={cn('relative overflow-hidden bg-black', className)}>
        <Image
          src={src}
          alt={alt}
          fill
          sizes={sizes}
          priority={priority}
          loading={priority ? undefined : 'lazy'}
          className="object-cover"
        />
        {children}
      </div>
    );
  }

  // Three angles and three focal points, chosen by seed. Enough variation that
  // a page of slots reads as a set of different photographs rather than as the
  // same tile repeated.
  const angle = [118, 196, 63][seed % 3] ?? 118;
  const focusX = [28, 72, 50][seed % 3] ?? 50;
  const focusY = [34, 62, 46][seed % 3] ?? 46;

  return (
    <div className={cn('relative overflow-hidden bg-black', className)} role="img" aria-label={alt}>
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `
            radial-gradient(58% 52% at ${String(focusX)}% ${String(focusY)}%, #3a4a39 0%, #1d271c 38%, transparent 72%),
            radial-gradient(42% 44% at ${String(100 - focusX)}% ${String(100 - focusY)}%, #2afd2322 0%, transparent 68%),
            linear-gradient(${String(angle)}deg, #0a0e0a 0%, #161d15 46%, #090c09 100%)
          `,
        }}
      />

      {/* Chrome sheen: a single soft diagonal highlight, the same gesture the
          logo uses. Bright enough to read as a lit surface rather than as an
          unloaded image - a fallback that looks broken is worse than no image. */}
      <div
        className="absolute inset-0 opacity-70"
        style={{
          backgroundImage: `linear-gradient(${String(angle + 40)}deg, transparent 30%, #c8cfc833 46%, #e8ede81a 52%, transparent 66%)`,
        }}
      />

      <div className="x-grid-field absolute inset-0 opacity-70" />

      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            'linear-gradient(180deg, transparent 58%, #020302b3 84%, #020302e6 100%)',
        }}
      />

      <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-xenon/30 to-transparent" />

      {isDevelopment ? (
        <span className="absolute bottom-3 left-4 font-mono text-[0.5625rem] tracking-[0.2em] text-ink-muted/60 uppercase">
          media slot · {slot}
        </span>
      ) : null}

      {children}
    </div>
  );
}
