'use client';

import { ArrowLeft, ArrowRight, Expand, X } from 'lucide-react';
import * as React from 'react';

import { Badge, Dialog, DialogContent, DialogTitle, VisuallyHidden, cn } from '@xenon/ui';
import { AnimatePresence, instant, motion, staggerDelay, useReducedMotion } from '@xenon/ui/motion';

import { stepIndex } from './paging';

import { MediaSlot } from '~/components/media/media-slot';

/**
 * The gallery wall and its lightbox.
 *
 * The grid is CSS columns rather than a layout library: the images are a mix of
 * aspect ratios, columns handle that natively, and a dependency for a photo
 * wall is not a trade worth making.
 *
 * The lightbox is a Radix dialog, which is how it gets focus trapping, scroll
 * locking and escape-to-close without three effects here each getting an edge
 * case slightly wrong. Arrow keys are added on top, because in a viewer of
 * sixty photographs they are the primary control and a lightbox that can only
 * be paged with the mouse is a lightbox nobody pages.
 */

export interface GalleryEntry {
  readonly id: string;
  readonly url: string | null;
  readonly caption: string | null;
  readonly photographer: string | null;
  readonly departmentName: string | null;
}

/** Ratios cycle so the columns never form visible horizontal bands. */
const ratios = ['aspect-4/5', 'aspect-square', 'aspect-4/3'] as const;

export function GalleryGrid({ items }: { items: readonly GalleryEntry[] }): React.ReactElement {
  const reduced = useReducedMotion();
  const [openIndex, setOpenIndex] = React.useState<number | null>(null);

  const open = openIndex !== null ? items[openIndex] : undefined;

  const step = React.useCallback(
    (delta: number) => {
      setOpenIndex((current) =>
        // Wraps, because a viewer that dead-ends at the last photograph makes
        // people click back through sixty to reach the first.
        current === null ? current : stepIndex(current, delta, items.length),
      );
    },
    [items.length],
  );

  React.useEffect(() => {
    if (openIndex === null) return;

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowRight') step(1);
      else if (event.key === 'ArrowLeft') step(-1);
      else return;
      // Only after a key that was actually handled: swallowing every keystroke
      // would break the dialog's own escape and tab handling.
      event.preventDefault();
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [openIndex, step]);

  return (
    <>
      <div className="columns-1 gap-4 sm:columns-2 lg:columns-3 xl:columns-4">
        {items.map((item, index) => (
          <motion.div
            key={item.id}
            className="mb-4 break-inside-avoid"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.15 }}
            transition={instant(reduced, {
              duration: 0.6,
              delay: staggerDelay(index, Math.min(items.length, 12)),
              ease: [0.16, 1, 0.3, 1],
            })}
          >
            <figure className="group relative overflow-hidden rounded-lg border border-line transition-colors duration-(--duration-base) hover:border-chrome-500">
              <button
                type="button"
                onClick={() => {
                  setOpenIndex(index);
                }}
                className="block w-full cursor-zoom-in text-left"
                aria-label={
                  item.caption === null ? 'Open this photograph' : `Open: ${item.caption}`
                }
              >
                <div className="relative overflow-hidden">
                  <MediaSlot
                    src={item.url}
                    alt={item.caption ?? 'A moment in Xenon'}
                    slot={`gallery.${item.id}`}
                    seed={index}
                    className={cn(
                      ratios[index % ratios.length],
                      // The crop pushes in slightly under the pointer. 3% is
                      // enough to register as a response and small enough that
                      // nothing important leaves the frame.
                      'transition-transform duration-(--duration-slow) ease-standard group-hover:scale-[1.03]',
                      'motion-reduce:transition-none motion-reduce:group-hover:scale-100',
                    )}
                    sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
                  />

                  {/* The expand affordance, which only exists on devices that
                      can hover. On touch the whole frame is the target and an
                      icon that never appears is dead weight. */}
                  <span
                    aria-hidden
                    className="absolute top-3 right-3 hidden rounded-sm bg-void/70 p-1.5 text-ink opacity-0 backdrop-blur-sm transition-opacity duration-(--duration-fast) group-hover:opacity-100 sm:block"
                  >
                    <Expand className="size-3.5" />
                  </span>
                </div>
              </button>

              {item.caption === null && item.photographer === null ? null : (
                <figcaption className="flex flex-col gap-1.5 bg-surface p-4">
                  {item.caption === null ? null : (
                    <p className="text-sm leading-snug text-ink-secondary">{item.caption}</p>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    {item.photographer === null ? null : (
                      <span className="x-eyebrow">{item.photographer}</span>
                    )}
                    {item.departmentName === null ? null : (
                      <Badge tone="chrome">{item.departmentName}</Badge>
                    )}
                  </div>
                </figcaption>
              )}
            </figure>
          </motion.div>
        ))}
      </div>

      <Dialog
        open={openIndex !== null}
        onOpenChange={(next) => {
          if (!next) setOpenIndex(null);
        }}
      >
        <DialogContent
          showClose={false}
          className="inset-0 max-w-none gap-0 rounded-none border-0 bg-void/95 p-0 backdrop-blur-xl data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in"
        >
          <VisuallyHidden>
            <DialogTitle>{open?.caption ?? 'Photograph'}</DialogTitle>
          </VisuallyHidden>

          <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-center justify-between gap-4 p-4">
              <p className="x-tabular font-mono text-[0.625rem] tracking-[0.16em] text-ink-muted uppercase">
                {openIndex === null ? null : `${String(openIndex + 1)} / ${String(items.length)}`}
              </p>
              <button
                type="button"
                onClick={() => {
                  setOpenIndex(null);
                }}
                aria-label="Close"
                className="rounded-sm p-2 text-ink-secondary transition-colors duration-(--duration-fast) hover:bg-elevated hover:text-ink"
              >
                <X className="size-5" />
              </button>
            </div>

            <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 sm:px-16">
              <Stepper
                direction="previous"
                onClick={() => {
                  step(-1);
                }}
              />

              {/*
                Keyed on the photograph, so paging swaps two elements rather
                than mutating one - which is what lets the outgoing frame leave
                while the incoming one arrives. `mode="wait"` would be wrong
                here: a viewer that goes blank between photographs feels slower
                than one that crossfades, even though it is not.
              */}
              <AnimatePresence initial={false}>
                {open === undefined ? null : (
                  <motion.figure
                    key={open.id}
                    className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-4 py-2 sm:px-16"
                    initial={reduced === true ? false : { opacity: 0, scale: 0.98 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, transition: { duration: 0.14 } }}
                    transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <MediaSlot
                      src={open.url}
                      alt={open.caption ?? 'A moment in Xenon'}
                      slot={`gallery.lightbox.${open.id}`}
                      priority
                      className="max-h-full min-h-0 w-full flex-1 rounded-lg"
                      sizes="100vw"
                    />

                    {open.caption === null && open.photographer === null ? null : (
                      <motion.figcaption
                        className="flex shrink-0 flex-wrap items-center justify-center gap-3 text-center"
                        initial={reduced === true ? false : { opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        // Trails the image so the picture lands first and the
                        // words follow it, rather than both arriving at once.
                        transition={{ duration: 0.3, delay: 0.14, ease: [0.16, 1, 0.3, 1] }}
                      >
                        {open.caption === null ? null : (
                          <p className="text-sm text-ink-secondary">{open.caption}</p>
                        )}
                        {open.photographer === null ? null : (
                          <span className="x-eyebrow">{open.photographer}</span>
                        )}
                        {open.departmentName === null ? null : (
                          <Badge tone="chrome">{open.departmentName}</Badge>
                        )}
                      </motion.figcaption>
                    )}
                  </motion.figure>
                )}
              </AnimatePresence>

              <Stepper
                direction="next"
                onClick={() => {
                  step(1);
                }}
              />
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Page control. The arrow travels 2px toward its own direction on hover. */
function Stepper({
  direction,
  onClick,
}: {
  direction: 'previous' | 'next';
  onClick: () => void;
}): React.ReactElement {
  const next = direction === 'next';

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={next ? 'Next photograph' : 'Previous photograph'}
      className={cn(
        'group absolute top-1/2 z-10 -translate-y-1/2 rounded-full border border-line-strong bg-void/70 p-3 text-ink-secondary backdrop-blur-sm',
        'transition-colors duration-(--duration-fast) hover:border-chrome-500 hover:text-ink',
        next ? 'right-2 sm:right-4' : 'left-2 sm:left-4',
      )}
    >
      {next ? (
        <ArrowRight className="size-4 transition-transform duration-(--duration-fast) ease-standard group-hover:translate-x-0.5" />
      ) : (
        <ArrowLeft className="size-4 transition-transform duration-(--duration-fast) ease-standard group-hover:-translate-x-0.5" />
      )}
    </button>
  );
}
