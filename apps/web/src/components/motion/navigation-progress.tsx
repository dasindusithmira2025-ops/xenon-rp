'use client';

import { usePathname } from 'next/navigation';
import * as React from 'react';

/**
 * The global navigation rail.
 *
 * A 2px Xenon line across the very top of the viewport that runs while a route
 * is being fetched and rendered. It is the product's most-seen piece of motion,
 * so it is also the one with the strictest rules:
 *
 *  - It is honest. Route loading has no measurable percentage - the browser
 *    cannot know how much of a server component tree has streamed - so the bar
 *    eases toward a ceiling it never reaches on its own and only completes when
 *    the navigation actually commits. It carries no number and no label,
 *    because any figure it displayed would be invented.
 *  - It never slows anything down. There is no minimum display time and no
 *    delay added to the navigation. If a prefetched route resolves in 40ms the
 *    bar is never shown at all: it waits 120ms before appearing, which is under
 *    the threshold at which a delay is perceived as a wait, and a flicker of a
 *    loading bar is worse than no loading bar.
 *  - It costs one animation frame and zero React renders. Everything is written
 *    straight to the node's style, because a progress bar that re-rendered a
 *    root-layout component sixty times a second would make navigation measurably
 *    slower in order to say that navigation was happening.
 *
 * What it cannot catch: a `router.push` from inside a component, because there
 * is no DOM event for one. Those are rare here - almost every navigation in the
 * product is a `<Link>` - and the safety timeout below means the worst case is
 * a bar that is never shown rather than one that never leaves.
 */

/** How long a navigation must take before a loader is worth showing. */
const APPEAR_AFTER_MS = 120;
/** The bar eases toward this and stops. It must never reach 100% on its own. */
const CEILING = 0.9;
/**
 * Time constant of the approach, in milliseconds.
 *
 * Exponential rather than linear: the first third of the bar crosses in a few
 * hundred milliseconds, then it visibly decelerates. That shape is what makes a
 * long wait feel like progress and a short one feel instant.
 */
const TAU_MS = 1_400;
/** Nothing in this product takes this long. A bar stuck on screen is a bug. */
const ABANDON_AFTER_MS = 20_000;

export function NavigationProgress(): React.ReactElement {
  const pathname = usePathname();
  const barRef = React.useRef<HTMLDivElement>(null);

  /*
   * All of the animation state lives in one ref.
   *
   * Not React state: this updates every frame, and a component in the root
   * layout that re-rendered at 60Hz would re-render the entire application
   * under it.
   */
  const run = React.useRef({
    active: false,
    progress: 0,
    frame: 0,
    startedAt: 0,
    appearTimer: 0,
    resetTimer: 0,
  });

  /*
   * Slide a full-width bar out from under a clipping track rather than scaling
   * it. A `scaleX` would squash the trailing highlight along with the bar and
   * the head of the line would be a sliver at 10% and a smear at 90%; sliding
   * keeps the leading edge exactly the same shape at every position.
   */
  const paint = React.useCallback((progress: number, visible: boolean) => {
    const bar = barRef.current;
    if (bar === null) return;
    bar.style.transform = `translate3d(${String((progress - 1) * 100)}%, 0, 0)`;
    bar.style.opacity = visible ? '1' : '0';
  }, []);

  const stop = React.useCallback(() => {
    const state = run.current;
    if (state.frame !== 0) cancelAnimationFrame(state.frame);
    clearTimeout(state.appearTimer);
    state.frame = 0;
    state.appearTimer = 0;
    state.active = false;
  }, []);

  /** Snap to full, fade, then reset to zero behind the fade. */
  const finish = React.useCallback(() => {
    const state = run.current;
    if (!state.active) return;
    stop();

    const bar = barRef.current;
    if (bar === null) return;

    // A bar that was never shown should not flash on its way out.
    if (bar.style.opacity === '0' || bar.style.opacity === '') {
      state.progress = 0;
      return;
    }

    bar.style.transition = 'transform 180ms var(--ease-standard), opacity 260ms 160ms linear';
    paint(1, false);

    clearTimeout(state.resetTimer);
    state.resetTimer = window.setTimeout(() => {
      const node = barRef.current;
      if (node === null) return;
      node.style.transition = 'none';
      state.progress = 0;
      paint(0, false);
    }, 440);
  }, [paint, stop]);

  const start = React.useCallback(() => {
    const state = run.current;
    if (state.active) return;

    clearTimeout(state.resetTimer);
    state.active = true;
    state.progress = 0;
    state.startedAt = performance.now();

    const bar = barRef.current;
    if (bar !== null) {
      bar.style.transition = 'none';
      paint(0, false);
    }

    // Held back so a prefetched route that resolves immediately shows nothing.
    state.appearTimer = window.setTimeout(() => {
      const node = barRef.current;
      if (node === null) return;
      node.style.transition = 'opacity 120ms linear';
      node.style.opacity = '1';
    }, APPEAR_AFTER_MS);

    let previous = state.startedAt;

    const step = (now: number): void => {
      const delta = now - previous;
      previous = now;

      if (now - state.startedAt > ABANDON_AFTER_MS) {
        finish();
        return;
      }

      // Frame-rate independent: the same curve on a 60Hz laptop and a 120Hz
      // phone. A per-frame constant would run the bar twice as fast on one.
      state.progress += (CEILING - state.progress) * (1 - Math.exp(-delta / TAU_MS));
      paint(state.progress, true);
      state.frame = requestAnimationFrame(step);
    };

    state.frame = requestAnimationFrame(step);
  }, [finish, paint]);

  /*
   * Navigation has committed when the path React is rendering changes.
   *
   * This fires on the render that follows the new route being ready, which is
   * exactly the moment the bar should complete.
   */
  React.useEffect(() => {
    finish();
  }, [pathname, finish]);

  React.useEffect(() => {
    /*
     * Capture phase, so the bar starts even if the link's own handler stops
     * propagation on its way up.
     */
    const onClick = (event: MouseEvent): void => {
      if (event.defaultPrevented || event.button !== 0) return;
      // A modified click opens a tab; this document is not navigating.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const anchor = (event.target as Element | null)?.closest('a');
      if (anchor === null || anchor === undefined) return;
      if (anchor.target !== '' && anchor.target !== '_self') return;
      if (anchor.hasAttribute('download')) return;

      const href = anchor.getAttribute('href');
      if (href === null || href.startsWith('#')) return;

      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      // An in-page anchor or a link to where we already are renders nothing new.
      if (url.pathname === window.location.pathname && url.search === window.location.search) {
        return;
      }

      start();
    };

    /*
     * Back and forward.
     *
     * `popstate` fires before the new route renders, so the bar starts here and
     * is completed by the pathname effect above, same as a click.
     */
    const onPopState = (): void => {
      start();
    };

    document.addEventListener('click', onClick, { capture: true });
    window.addEventListener('popstate', onPopState);

    const state = run.current;
    return () => {
      document.removeEventListener('click', onClick, { capture: true });
      window.removeEventListener('popstate', onPopState);
      if (state.frame !== 0) cancelAnimationFrame(state.frame);
      clearTimeout(state.appearTimer);
      clearTimeout(state.resetTimer);
    };
  }, [start]);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-90 h-0.5 overflow-hidden"
    >
      <div
        ref={barRef}
        className="relative size-full bg-xenon opacity-0 shadow-[0_0_10px_1px_#2afd2399] will-change-transform"
        style={{ transform: 'translate3d(-100%, 0, 0)' }}
      >
        {/* The head of the line: a short brighter length at the leading edge,
            which is what makes the bar read as travelling rather than growing. */}
        <span className="absolute inset-y-0 right-0 w-28 bg-gradient-to-r from-transparent to-xenon-bright" />
      </div>
    </div>
  );
}
