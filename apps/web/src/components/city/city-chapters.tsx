'use client';

import { Check } from 'lucide-react';
import * as React from 'react';

import { cn, Eyebrow } from '@xenon/ui';
import {
  MaskReveal,
  MediaReveal,
  motion,
  Parallax,
  Reveal,
  useReducedMotion,
} from '@xenon/ui/motion';

import { MediaSlot } from '~/components/media/media-slot';
import { Section } from '~/components/site/section';

/**
 * The city, told as chapters.
 *
 * Four facets, alternating sides, with a rail down the edge of the viewport
 * marking which one you are in. The rail is the "you are here" the page was
 * missing: on a route this tall, a reader three screens down has no idea
 * whether they are a quarter or three quarters through.
 *
 * What this deliberately is not is a scroll-jacked story. The browser scrolls
 * at exactly the speed the reader asked for, nothing is pinned, and every
 * chapter is reachable by dragging the scrollbar or by pressing End. The only
 * thing scroll position drives is which number on the rail is lit - which is
 * an observation about where the reader is, not a claim on where they go next.
 *
 * `IntersectionObserver` rather than a scroll handler: one observer watching
 * four sections costs nothing and never runs on the main thread during a
 * scroll, where a `getBoundingClientRect` per frame per chapter would.
 */

export interface CityFacet {
  readonly eyebrow: string;
  readonly title: string;
  readonly body: string;
  readonly points: readonly string[];
}

export function CityChapters({ facets }: { facets: readonly CityFacet[] }): React.ReactElement {
  const [active, setActive] = React.useState(0);
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const sections = [...container.querySelectorAll('[data-chapter]')];
    if (sections.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = Number((entry.target as HTMLElement).dataset.chapter);
          if (Number.isFinite(index)) setActive(index);
        }
      },
      {
        /*
         * A band across the middle of the viewport rather than the whole of it.
         *
         * With the default root the observer reports a chapter as soon as one
         * pixel of it appears, so two chapters are "current" through every
         * transition and the rail flickers between them. Collapsing the root to
         * a strip through the centre means exactly one chapter can own it.
         */
        rootMargin: '-45% 0px -45% 0px',
        threshold: 0,
      },
    );

    for (const section of sections) observer.observe(section);
    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <ChapterRail facets={facets} active={active} />

      {facets.map((facet, index) => (
        <Section
          key={facet.eyebrow}
          tone={index % 2 === 0 ? 'void' : 'black'}
          width="wide"
          id={`chapter-${String(index)}`}
        >
          <div
            data-chapter={index}
            className="grid gap-12 scroll-mt-24 lg:grid-cols-2 lg:items-center lg:gap-20"
          >
            <MediaReveal
              className={cn('rounded-xl border border-line', index % 2 === 0 && 'lg:order-2')}
            >
              <Parallax strength={0.08} className="aspect-4/3">
                <MediaSlot
                  src={null}
                  alt={facet.title}
                  slot={`city.${facet.eyebrow.toLowerCase()}`}
                  seed={index}
                  className="size-full"
                  sizes="(max-width: 1024px) 100vw, 48vw"
                />
              </Parallax>
            </MediaReveal>

            <div className="flex flex-col gap-6">
              <Reveal distance={10}>
                <Eyebrow accent>{facet.eyebrow}</Eyebrow>
              </Reveal>

              <MaskReveal delay={0.08} amount={0.35}>
                <h2 className="font-display text-headline font-black text-ink uppercase">
                  {facet.title}
                </h2>
              </MaskReveal>

              <Reveal delay={0.18} distance={14}>
                <p className="text-lead text-ink-secondary">{facet.body}</p>
              </Reveal>

              <ul className="mt-2 flex flex-col gap-3">
                {facet.points.map((point, pointIndex) => (
                  <Reveal
                    key={point}
                    as="li"
                    delay={0.26 + pointIndex * 0.06}
                    distance={10}
                    className="flex items-start gap-3 text-sm text-ink-secondary"
                  >
                    <Check className="mt-0.5 size-4 shrink-0 text-xenon" aria-hidden />
                    {point}
                  </Reveal>
                ))}
              </ul>
            </div>
          </div>
        </Section>
      ))}
    </div>
  );
}

/**
 * The chapter rail.
 *
 * Desktop only, and hidden from assistive technology: the sections it indexes
 * are already headings in the document, so a screen reader has a better table
 * of contents than this one and does not need it read out twice.
 *
 * Each entry is a link to its own section, so it is a working table of contents
 * for a pointer as well as a position readout.
 */
function ChapterRail({
  facets,
  active,
}: {
  facets: readonly CityFacet[];
  active: number;
}): React.ReactElement {
  const reduced = useReducedMotion();

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed top-1/2 right-6 z-30 hidden -translate-y-1/2 flex-col gap-4 xl:flex"
    >
      {facets.map((facet, index) => {
        const current = index === active;
        return (
          <a
            key={facet.eyebrow}
            href={`#chapter-${String(index)}`}
            className="pointer-events-auto group flex items-center justify-end gap-3"
            tabIndex={-1}
          >
            <span
              className={cn(
                'font-mono text-[0.5625rem] tracking-[0.2em] uppercase transition-all duration-(--duration-base) ease-standard',
                current
                  ? 'text-xenon opacity-100'
                  : 'text-ink-muted opacity-0 group-hover:opacity-100',
              )}
            >
              {facet.eyebrow}
            </span>

            {/*
              The marker is a short bar that lengthens and takes the accent
              when its chapter owns the middle of the viewport.

              A fixed 28px bar scaled from its right edge, not an animated
              `width`. Width is a layout property; scale is not, and the rule
              that everything animates on transform or opacity does not get an
              exception for being small.
            */}
            <motion.span
              className={cn(
                'block h-px w-7 origin-right rounded-pill',
                current ? 'bg-xenon' : 'bg-line-strong',
              )}
              initial={false}
              animate={{ scaleX: current ? 1 : 0.42 }}
              transition={
                reduced === true ? { duration: 0 } : { duration: 0.3, ease: [0.32, 0.72, 0, 1] }
              }
            />
          </a>
        );
      })}
    </div>
  );
}
