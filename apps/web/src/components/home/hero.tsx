'use client';

import Link from 'next/link';
import * as React from 'react';

import { Button, StatusDot } from '@xenon/ui';
import { Reveal, TextReveal } from '@xenon/ui/motion';

import { MediaSlot } from '~/components/media/media-slot';

/**
 * Homepage hero.
 *
 * Poster-first, always. The poster paints immediately and is what LCP measures;
 * the video, if the operator has configured one, is attached afterwards and
 * only once the connection and the viewport suggest it is worth the bytes. A
 * hero that ships 12 MB of H.264 to a phone on mobile data is not cinematic,
 * it is just slow.
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

function stateLine(state: HeroProps['serverState'], players: number | null): string {
  if (state === 'ONLINE') {
    return players === null ? 'City online' : `City online · ${String(players)} in the city`;
  }
  if (state === 'OFFLINE') return 'City offline · back shortly';
  if (state === 'DEGRADED') return 'Partial service';
  return 'Status unavailable';
}

export function Hero({
  videoUrl,
  posterUrl,
  serverState,
  playerCount,
  signedIn,
}: HeroProps): React.ReactElement {
  const [playVideo, setPlayVideo] = React.useState(false);

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
        <MediaSlot
          src={posterUrl}
          alt=""
          slot="home.hero.poster"
          priority
          sizes="100vw"
          className="size-full"
        />

        {playVideo && videoUrl !== null ? (
          <video
            className="absolute inset-0 size-full animate-fade-in object-cover"
            src={videoUrl}
            poster={posterUrl ?? undefined}
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
      </div>

      <div className="relative mx-auto w-full max-w-wide px-5 pt-32 pb-16 lg:px-8 lg:pb-24">
        <Reveal delay={0.15}>
          <p className="x-eyebrow mb-6 flex items-center gap-2.5">
            <StatusDot state={dotState[serverState]} />
            <span className="text-ink-secondary">{stateLine(serverState, playerCount)}</span>
          </p>
        </Reveal>

        <p className="x-eyebrow mb-4 text-xenon">Xenon Roleplay</p>

        <h1 className="font-display text-hero max-w-[16ch] font-black text-ink uppercase">
          <TextReveal lines={['This city', 'remembers.']} />
        </h1>

        <Reveal delay={0.5} className="mt-8 max-w-md">
          <p className="text-lead text-ink-secondary">
            Your actions create your reputation.
            <br />
            Your story defines the city.
          </p>
        </Reveal>

        <Reveal delay={0.65} className="mt-10 flex flex-col gap-3 sm:flex-row">
          <Button variant="accent" size="xl" asChild>
            <Link href="/city">Enter the city</Link>
          </Button>
          <Button variant="outline" size="xl" asChild>
            <Link href={signedIn ? '/applications' : '/signin'}>Apply now</Link>
          </Button>
        </Reveal>
      </div>

      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-b from-transparent to-void"
      />
    </section>
  );
}
