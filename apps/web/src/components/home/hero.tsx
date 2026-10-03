'use client';

import Link from 'next/link';
import * as React from 'react';

import { Button, StatusDot } from '@xenon/ui';
import {
  AnimatedCounter,
  instant,
  motion,
  Reveal,
  TextReveal,
  useReducedMotion,
} from '@xenon/ui/motion';

import { MediaSlot } from '~/components/media/media-slot';
import { useEntryDelay } from '~/components/motion/first-entry';

/**
 * Homepage hero.
 *
 * Poster-first, always. The poster paints immediately and is what LCP measures;
 * the video, if the operator has configured one, is attached afterwards and
 * only once the connection and the viewport suggest it is worth the bytes. A
 * hero that ships 12 MB of H.264 to a phone on mobile data is not cinematic,
 * it is just slow.
 *
 * The entrance is the most choreographed thing in the product, and it runs in
 * one direction only:
 *
 *   veil lifts  →  eyebrow  →  headline, line by line  →  standfirst
 *   →  buttons  →  live status  →  scroll cue
 *
 * Everything is a mask or a short lift. Nothing counts letters, nothing
 * bounces, and the whole sequence is over inside two seconds. The delays are
 * offsets from `useEntryDelay`, which is zero on a repeat visit - so a returning
 * visitor gets the same choreography without the wait for a title card they
 * have already seen.
 *
 * The live state line renders a real reading or an honest "unavailable". There
 * is no invented player count anywhere in this component.
 */

export interface HeroProps {
  readonly videoUrl: string | null;
  readonly posterUrl: string | null;
  readonly serverState: 'ONLINE' | 'OFFLINE' | 'DEGRADED' | 'UNKNOWN';
  readonly playerCount: number | null;
  readonly signedIn: boolean;
}

const dotState = {
  ONLINE: 'online',
  OFFLINE: 'offline',
  DEGRADED: 'degraded',
  UNKNOWN: 'unknown',
} as const;

export function Hero({
  videoUrl,
  posterUrl,
  serverState,
  playerCount,
  signedIn,
}: HeroProps): React.ReactElement {
  const reduced = useReducedMotion();
  const base = useEntryDelay();

  const [playVideo, setPlayVideo] = React.useState(false);
  const [videoReady, setVideoReady] = React.useState(false);

  React.useEffect(() => {
    if (videoUrl === null) return;

    // Three gates before a single byte of video is requested: the viewer has
    // not asked for reduced motion, the connection is not metered or slow, and
    // the viewport is large enough for the detail to be worth anything.
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const smallViewport = window.matchMedia('(max-width: 767px)').matches;

    const connection = (
      navigator as Navigator & {
        connection?: { saveData?: boolean; effectiveType?: string };
      }
    ).connection;
    const constrained =
      connection?.saveData === true ||
      (connection?.effectiveType !== undefined && /2g|slow-2g|3g/.test(connection.effectiveType));

    if (reducedMotion || smallViewport || constrained) return;

    // Deferred past first paint so the video request never competes with the
    // poster for bandwidth.
    const timer = setTimeout(() => {
      setPlayVideo(true);
    }, 900);
    return () => {
      clearTimeout(timer);
    };
  }, [videoUrl]);

  return (
    <section className="relative flex min-h-[100svh] flex-col justify-end overflow-hidden">
      <div className="absolute inset-0">
        {/*
          A still image gets a held shot: 1.06 to 1.00 over thirty seconds, far
          below the threshold at which anyone consciously notices. A video moves
          on its own and does not need the help, so it does not get it.
        */}
        <HeldShot enabled={videoUrl === null || !videoReady}>
          <MediaSlot
            src={posterUrl}
            alt=""
            slot="home.hero.poster"
            priority
            sizes="100vw"
            className="size-full"
          />
        </HeldShot>

        {playVideo && videoUrl !== null ? (
          <video
            className="absolute inset-0 size-full object-cover transition-opacity duration-(--duration-cinematic) ease-standard"
            // Crossfaded on `canplay` rather than on mount. Attaching a video
            // element that has not buffered a frame paints a black rectangle
            // over the poster, which is the exact pop-in the poster exists to
            // prevent.
            style={{ opacity: videoReady ? 1 : 0 }}
            src={videoUrl}
            poster={posterUrl ?? undefined}
            onCanPlay={() => {
              setVideoReady(true);
            }}
            autoPlay
            muted
            loop
            playsInline
            aria-hidden
          />
        ) : null}

        {/*
          Atmosphere for the no-poster case.

          A hero with no photography still has to look like somewhere. These are
          a horizon glow low and right, a cold sky wash above it, and a single
          chrome streak - the shape of a city at night reduced to three
          gradients. Suppressed entirely once a real poster is configured, where
          they would only muddy the image.
        */}
        {posterUrl === null ? (
          <>
            <div
              aria-hidden
              className="absolute inset-0"
              style={{
                backgroundImage:
                  'radial-gradient(85% 60% at 78% 88%, #2afd231f 0%, #12401033 34%, transparent 72%)',
              }}
            />
            <div
              aria-hidden
              className="absolute inset-0"
              style={{
                backgroundImage:
                  'radial-gradient(70% 55% at 22% 8%, #1e2a3a66 0%, transparent 68%)',
              }}
            />
            <div
              aria-hidden
              className="absolute inset-0 opacity-40"
              style={{
                backgroundImage:
                  'linear-gradient(72deg, transparent 44%, #c8cfc826 52%, transparent 60%)',
              }}
            />
          </>
        ) : null}

        <div className="x-cinema-scrim absolute inset-0" />

        {/*
          The veil.

          An extra sheet of black over the finished scrim that retracts as the
          hero opens. It means the image resolves out of darkness rather than
          being there already, and because it is a fading overlay rather than a
          change to the image, it costs one composited opacity.
        */}
        <motion.div
          aria-hidden
          className="absolute inset-0 bg-void"
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={instant(reduced, { duration: 1.4, delay: base, ease: [0.16, 1, 0.3, 1] })}
        />
      </div>

      <div className="relative mx-auto w-full max-w-wide px-5 pt-32 pb-16 lg:px-8 lg:pb-24">
        <Reveal delay={base + 0.18} distance={12}>
          <p className="x-eyebrow mb-4 text-xenon">Xenon Roleplay</p>
        </Reveal>

        <h1 className="font-display text-hero max-w-[16ch] font-black text-ink uppercase">
          <TextReveal lines={['This city', 'remembers.']} delay={base + 0.28} />
        </h1>

        <Reveal delay={base + 0.7} className="mt-8 max-w-md" distance={16}>
          <p className="text-lead text-ink-secondary">
            Your actions create your reputation.
            <br />
            Your story defines the city.
          </p>
        </Reveal>

        <Reveal delay={base + 0.85} className="mt-10 flex flex-col gap-3 sm:flex-row" distance={16}>
          <Button variant="accent" size="xl" asChild>
            <Link href="/city">Enter the city</Link>
          </Button>
          <Button variant="outline" size="xl" asChild>
            <Link href={signedIn ? '/applications' : '/signin'}>Apply now</Link>
          </Button>
        </Reveal>

        {/*
          The city comes online last.

          Deliberately the final beat rather than the first: the status line is
          the one part of the hero that is live, and arriving after everything
          else has settled is what makes it read as a reading being taken rather
          than as another piece of layout.
        */}
        <Reveal delay={base + 1.05} className="mt-10" distance={10}>
          <LiveLine state={serverState} players={playerCount} />
        </Reveal>
      </div>

      <ScrollCue delay={base + 1.3} />

      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-b from-transparent to-void"
      />
    </section>
  );
}

/** Wraps children in the slow scale, or in nothing at all. */
function HeldShot({
  enabled,
  children,
}: {
  enabled: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return <div className={enabled ? 'x-ken-burns size-full' : 'size-full'}>{children}</div>;
}

/**
 * The live state line.
 *
 * The player count is the one number on the homepage that changes while someone
 * is looking at it, so it is the one that animates between values - and only
 * between values. `countOnReveal={false}` is the whole point: a counter that
 * ran up from zero every time the poller returned would be describing the city
 * emptying and refilling every thirty seconds, which is a lie told with a
 * transition.
 */
function LiveLine({
  state,
  players,
}: {
  state: HeroProps['serverState'];
  players: number | null;
}): React.ReactElement {
  return (
    <p className="x-eyebrow flex items-center gap-2.5">
      <StatusDot state={dotState[state]} />
      <span className="text-ink-secondary">
        {state === 'ONLINE' ? (
          players === null ? (
            'City online'
          ) : (
            <>
              City online ·{' '}
              <AnimatedCounter value={players} countOnReveal={false} className="text-ink" /> in the
              city
            </>
          )
        ) : state === 'OFFLINE' ? (
          'City offline · back shortly'
        ) : state === 'DEGRADED' ? (
          'Partial service'
        ) : (
          'Status unavailable'
        )}
      </span>
    </p>
  );
}

/**
 * The scroll cue.
 *
 * A hairline rail with a single point of light running down it, which says
 * "there is more below" without a bouncing chevron. The travel is one CSS
 * transform on one 4px dot; it stops under reduced motion and the rail itself
 * still reads as a downward gesture.
 */
function ScrollCue({ delay }: { delay: number }): React.ReactElement {
  const reduced = useReducedMotion();

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={instant(reduced, { duration: 0.6, delay, ease: [0.16, 1, 0.3, 1] })}
    >
      {/* Hidden below `sm`. On a 375px screen the hero already fills the
          viewport to the pixel and the cue lands on the live status line; a
          phone also does not need to be told that a page scrolls. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-8 z-1 hidden flex-col items-center gap-3 sm:flex">
        <span className="font-mono text-[0.5625rem] tracking-[0.3em] text-ink-muted uppercase">
          Scroll
        </span>
        <span className="relative block h-10 w-px overflow-hidden bg-line-strong">
          <span className="x-scroll-cue absolute inset-x-0 top-0 h-3 bg-gradient-to-b from-transparent to-xenon" />
        </span>
      </div>
    </motion.div>
  );
}
