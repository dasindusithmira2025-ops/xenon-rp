'use client';

import Image from 'next/image';
import * as React from 'react';

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
      <LoadedImage src={src} alt={alt} sizes={sizes} priority={priority} className={className}>
        {children}
      </LoadedImage>
    );
  }

  // Three angles and three focal points, chosen by seed. Enough variation that
  // a page of slots reads as a set of different photographs rather than as the
  // same tile repeated.
  const angle = [118, 196, 63][seed % 3] ?? 118;
  const focusX = [28, 72, 50][seed % 3] ?? 50;
  const focusY = [34, 62, 46][seed % 3] ?? 46;

  /*
   * The whole composition as one paint.
   *
   * This used to be five stacked absolutely-positioned layers - base, chrome
   * sheen, grid, vignette, hairline - which looks tidy in JSX and is the single
   * most expensive thing on a page that has not been given photography yet.
   * Ten slots became fifty full-size layers for the compositor to re-raster on
   * every scroll frame, and measuring it was unambiguous: on the homepage,
   * hiding these fallbacks took dropped frames from 10% of a scroll to zero.
   *
   * CSS takes a list of background layers with per-layer sizing, so the same
   * image is describable in one element and one paint. Topmost first, which is
   * the reverse of the DOM order it replaces:
   *
   *   hairline → vignette → grid → chrome sheen → accent glow → base
   *
   * The output is pixel-identical. Only the layer count changed.
   */
  const fallback = [
    // A single green hairline along the bottom edge, drawn as a 1px-tall layer
    // pinned to the bottom rather than as its own element.
    'linear-gradient(90deg, transparent, #2afd234d 50%, transparent)',
    'linear-gradient(180deg, transparent 58%, #020302b3 84%, #020302e6 100%)',
    'linear-gradient(to right, #ffffff06 1px, transparent 1px)',
    'linear-gradient(to bottom, #ffffff06 1px, transparent 1px)',
    `linear-gradient(${String(angle + 40)}deg, transparent 30%, #c8cfc824 46%, #e8ede812 52%, transparent 66%)`,
    `radial-gradient(58% 52% at ${String(focusX)}% ${String(focusY)}%, #3a4a39 0%, #1d271c 38%, transparent 72%)`,
    `radial-gradient(42% 44% at ${String(100 - focusX)}% ${String(100 - focusY)}%, #2afd2322 0%, transparent 68%)`,
    `linear-gradient(${String(angle)}deg, #0a0e0a 0%, #161d15 46%, #090c09 100%)`,
  ].join(', ');

  return (
    <div
      className={cn('relative overflow-hidden bg-black', className)}
      role="img"
      aria-label={alt}
      style={{
        backgroundImage: fallback,
        backgroundSize: '100% 1px, auto, 48px 48px, 48px 48px, auto, auto, auto, auto',
        backgroundPosition: 'bottom, 0 0, 0 0, 0 0, 0 0, 0 0, 0 0, 0 0',
        backgroundRepeat:
          'no-repeat, no-repeat, repeat, repeat, no-repeat, no-repeat, no-repeat, no-repeat',
      }}
    >
      {isDevelopment ? (
        <span className="absolute bottom-3 left-4 font-mono text-[0.5625rem] tracking-[0.2em] text-ink-muted/60 uppercase">
          media slot · {slot}
        </span>
      ) : null}

      {children}
    </div>
  );
}

/**
 * A configured image, resolving rather than appearing.
 *
 * Decoded images arrive whenever the network says so, and the default result is
 * a rectangle that snaps from empty to full somewhere in the middle of a scroll.
 * This settles the last 1.5% of a scale and a short opacity over a dark
 * container instead, so an image that arrives late reads as focus pulling in.
 *
 * There is no white anywhere in the sequence. The container is already black,
 * so the "flash" case that plagues light themes cannot happen here - the frame
 * is simply empty until it is not.
 */
function LoadedImage({
  src,
  alt,
  sizes,
  priority,
  className,
  children,
}: {
  src: string;
  alt: string;
  sizes: string;
  priority: boolean;
  className?: string;
  children?: React.ReactNode;
}): React.ReactElement {
  const [loaded, setLoaded] = React.useState(false);
  const ref = React.useRef<HTMLImageElement>(null);

  /*
   * An image served from cache can finish decoding before React attaches the
   * `load` handler, in which case the event has already fired and never fires
   * again - leaving the element at zero opacity forever. Checking `complete`
   * once on mount closes that hole.
   *
   * The check runs in a frame callback rather than in the effect body: the
   * result is one frame of an already-empty container, which is invisible, and
   * it keeps a synchronous setState out of an effect.
   */
  React.useEffect(() => {
    if (ref.current?.complete !== true) return;
    const frame = requestAnimationFrame(() => {
      setLoaded(true);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div className={cn('relative overflow-hidden bg-black', className)}>
      <Image
        ref={ref}
        src={src}
        alt={alt}
        fill
        sizes={sizes}
        priority={priority}
        loading={priority ? undefined : 'lazy'}
        onLoad={() => {
          setLoaded(true);
        }}
        // A broken or blocked image must not be left invisible: a missing
        // photograph should look like a missing photograph, not like a bug in
        // the reveal.
        onError={() => {
          setLoaded(true);
        }}
        className={cn(
          'object-cover transition-[opacity,transform] duration-(--duration-cinematic) ease-standard motion-reduce:transition-none',
          loaded ? 'scale-100 opacity-100' : 'scale-[1.015] opacity-0',
        )}
      />
      {children}
    </div>
  );
}
