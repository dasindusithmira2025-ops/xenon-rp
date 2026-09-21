import { ArrowRight, ArrowUpRight } from 'lucide-react';
import Link from 'next/link';

import { Badge, Button, Eyebrow, Panel, StatusDot } from '@xenon/ui';
import { Parallax, Reveal, Stagger, StaggerItem } from '@xenon/ui/motion';

import { MediaSlot } from '~/components/media/media-slot';
import { Section, SectionHeading } from '~/components/site/section';
import {
  citySystems,
  communityCopy,
  creatorCopy,
  storyPaths,
  whitelistCopy,
} from '~/content/marketing';

/**
 * Homepage sections.
 *
 * Composition notes, because they are the whole point of the page:
 *
 *  - No section repeats the shape of the one before it. The page alternates
 *    full-bleed media, editorial two-column, an asymmetric grid and a dense
 *    list, so scrolling feels like moving through a film rather than down a
 *    list of cards.
 *  - Numbers are only ever rendered from real data. Where there is no reading,
 *    the component says so.
 */

// --- Live city ---------------------------------------------------------------

export interface LiveCityProps {
  readonly state: 'ONLINE' | 'OFFLINE' | 'DEGRADED' | 'UNKNOWN';
  readonly playerCount: number | null;
  readonly maxPlayers: number | null;
  readonly nextRestart: string | null;
  readonly connectUrl: string | null;
}

const dotState = {
  ONLINE: 'online',
  OFFLINE: 'offline',
  DEGRADED: 'degraded',
  UNKNOWN: 'unknown',
} as const;

/**
 * The live strip directly under the hero.
 *
 * Every figure here is a real reading or the word "unavailable". This is the
 * component a visitor checks to decide whether to download 90 GB of game, and
 * a comforting fiction would be worse than an honest gap.
 */
export function LiveCity({
  state,
  playerCount,
  maxPlayers,
  nextRestart,
  connectUrl,
}: LiveCityProps): React.ReactElement {
  const figures = [
    {
      label: 'In the city',
      value: state === 'ONLINE' && playerCount !== null ? String(playerCount) : '—',
      hint:
        state === 'ONLINE' && playerCount !== null && maxPlayers !== null
          ? `of ${String(maxPlayers)} slots`
          : 'no live reading',
    },
    {
      label: 'Server',
      value:
        state === 'ONLINE'
          ? 'Online'
          : state === 'OFFLINE'
            ? 'Offline'
            : state === 'DEGRADED'
              ? 'Partial'
              : 'Unknown',
      hint: state === 'UNKNOWN' ? 'status poller has no data' : 'updated continuously',
    },
    {
      label: 'Next restart',
      value:
        nextRestart === null
          ? '—'
          : new Date(nextRestart).toLocaleTimeString('en-GB', {
              hour: '2-digit',
              minute: '2-digit',
              timeZone: 'UTC',
            }),
      hint: nextRestart === null ? 'not scheduled' : 'UTC',
    },
  ];

  return (
    <Section tone="black" size="sm" width="wide" className="border-y border-line">
      <div className="flex flex-col gap-8 lg:flex-row lg:items-center lg:justify-between">
        <div className="grid flex-1 grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3">
          {figures.map((figure) => (
            <div key={figure.label} className="flex flex-col gap-1.5">
              <p className="x-eyebrow">{figure.label}</p>
              <p className="x-tabular font-display text-4xl leading-none font-black text-ink">
                {figure.value}
              </p>
              <p className="text-xs text-ink-muted">{figure.hint}</p>
            </div>
          ))}
        </div>

        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center lg:shrink-0">
          <span className="inline-flex items-center gap-2 rounded-pill border border-line-strong px-3 py-1.5">
            <StatusDot state={dotState[state]} />
            <span className="font-mono text-[0.625rem] tracking-[0.14em] text-ink-secondary uppercase">
              Live
            </span>
          </span>
          {connectUrl === null ? (
            <Button variant="outline" asChild>
              <Link href="/status">Server status</Link>
            </Button>
          ) : (
            <Button variant="outline" asChild>
              <a href={connectUrl} target="_blank" rel="noopener noreferrer">
                Connect <ArrowUpRight />
              </a>
            </Button>
          )}
        </div>
      </div>
    </Section>
  );
}

// --- This is Xenon -----------------------------------------------------------

export function ThisIsXenon(): React.ReactElement {
  return (
    <Section size="lg" width="wide">
      <div className="grid gap-12 lg:grid-cols-[1.05fr_1fr] lg:items-center lg:gap-20">
        <div className="flex flex-col gap-7">
          <Eyebrow accent>This is Xenon</Eyebrow>
          <h2 className="font-display text-headline font-black text-ink uppercase">
            Not a server.
            <br />
            <span className="x-chrome-text">A place people</span>
            <br />
            keep coming back to.
          </h2>
          <div className="flex max-w-xl flex-col gap-5 text-lead text-ink-secondary">
            <p>
              Xenon is a Sri Lankan FiveM city built on one idea: that what you did yesterday should
              still matter today. Characters persist. Reputations persist. So do grudges.
            </p>
            <p>
              That only works if everyone is playing the same game, which is why the whitelist
              exists, why the rulebook is written properly, and why every application is read by a
              person.
            </p>
          </div>
          <div className="flex flex-wrap gap-3 pt-2">
            <Button variant="accent" asChild>
              <Link href="/applications">
                Apply for whitelist <ArrowRight />
              </Link>
            </Button>
            <Button variant="ghost" asChild>
              <Link href="/rules">Read the rulebook</Link>
            </Button>
          </div>
        </div>

        <Reveal>
          <Parallax strength={0.1} className="aspect-4/5 rounded-xl border border-line">
            <MediaSlot
              src={null}
              alt="Night street in Xenon"
              slot="home.statement"
              seed={1}
              className="size-full"
              sizes="(max-width: 1024px) 100vw, 45vw"
            />
          </Parallax>
        </Reveal>
      </div>
    </Section>
  );
}

// --- Choose your story -------------------------------------------------------

export function ChooseYourStory(): React.ReactElement {
  return (
    <Section tone="black" width="wide" size="lg">
      <SectionHeading
        eyebrow="Choose your story"
        title={
          <>
            Five ways in.
            <br />
            None of them easy.
          </>
        }
        lead="Xenon does not assign you a role. You pick a direction, and the city decides what it costs."
      />

      <div className="mt-14 flex flex-col divide-y divide-line border-y border-line">
        {storyPaths.map((path, index) => (
          <Reveal key={path.key} delay={index * 0.04}>
            <article className="group grid gap-5 py-8 lg:grid-cols-[6rem_1fr_1.15fr] lg:items-start lg:gap-10 lg:py-12">
              <div className="flex items-center gap-4 lg:flex-col lg:items-start lg:gap-3">
                <span className="font-mono text-[0.6875rem] tracking-[0.2em] text-ink-muted">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <Badge tone={path.key === 'underworld' ? 'danger' : 'neutral'}>{path.label}</Badge>
              </div>

              <h3 className="font-display text-title font-bold text-ink transition-colors duration-(--duration-base) group-hover:text-xenon">
                {path.headline}
              </h3>

              <div className="flex flex-col gap-3">
                <p className="leading-relaxed text-ink-secondary">{path.body}</p>
                <p className="x-eyebrow">{path.note}</p>
              </div>
            </article>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}

// --- City showcase -----------------------------------------------------------

/**
 * Asymmetric media composition.
 *
 * Three slots at three different aspect ratios, offset vertically. Equal tiles
 * in a neat row is the single most template-looking thing a site can do.
 */
export function CityShowcase(): React.ReactElement {
  return (
    <Section width="wide" size="lg">
      <SectionHeading
        eyebrow="The city"
        title="Somewhere worth photographing"
        lead="Every frame here belongs to the community. Replace these slots with your own."
        action={
          <Button variant="outline" asChild>
            <Link href="/gallery">
              Open the gallery <ArrowRight />
            </Link>
          </Button>
        }
      />

      <div className="mt-14 grid gap-4 sm:grid-cols-12 sm:gap-5">
        <Reveal className="sm:col-span-7">
          <MediaSlot
            src={null}
            alt="Downtown Xenon at night"
            slot="home.showcase.1"
            seed={0}
            className="aspect-16/10 rounded-lg border border-line"
            sizes="(max-width: 640px) 100vw, 58vw"
          />
        </Reveal>

        <Reveal delay={0.1} className="sm:col-span-5 sm:mt-10">
          <MediaSlot
            src={null}
            alt="A Xenon traffic stop"
            slot="home.showcase.2"
            seed={1}
            className="aspect-4/5 rounded-lg border border-line"
            sizes="(max-width: 640px) 100vw, 40vw"
          />
        </Reveal>

        <Reveal delay={0.15} className="sm:col-span-5">
          <MediaSlot
            src={null}
            alt="A Xenon garage"
            slot="home.showcase.3"
            seed={2}
            className="aspect-square rounded-lg border border-line"
            sizes="(max-width: 640px) 100vw, 40vw"
          />
        </Reveal>

        <Reveal delay={0.2} className="sm:col-span-7 sm:-mt-6">
          <MediaSlot
            src={null}
            alt="The Xenon waterfront"
            slot="home.showcase.4"
            seed={1}
            className="aspect-16/9 rounded-lg border border-line"
            sizes="(max-width: 640px) 100vw, 58vw"
          />
        </Reveal>
      </div>
    </Section>
  );
}

// --- City systems ------------------------------------------------------------

export function CitySystems(): React.ReactElement {
  return (
    <Section tone="black" width="wide" size="lg">
      <div className="grid gap-12 lg:grid-cols-[0.85fr_1.15fr] lg:gap-20">
        <div className="lg:sticky lg:top-32 lg:self-start">
          <SectionHeading
            eyebrow="City systems"
            title="What the city is built around"
            lead="Not a feature list. The things everything else depends on."
          />
        </div>

        <Stagger className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2">
          {citySystems.map((system) => (
            <StaggerItem
              key={system.title}
              className="bg-surface p-7 transition-colors hover:bg-elevated"
            >
              <h3 className="font-display text-lg font-bold text-ink">{system.title}</h3>
              <p className="mt-2.5 text-sm leading-relaxed text-ink-secondary">{system.body}</p>
            </StaggerItem>
          ))}
        </Stagger>
      </div>
    </Section>
  );
}

// --- Underworld --------------------------------------------------------------

export function Underworld(): React.ReactElement {
  return (
    <section className="relative overflow-hidden">
      <MediaSlot
        src={null}
        alt=""
        slot="home.underworld"
        seed={2}
        className="absolute inset-0 size-full"
        sizes="100vw"
      />
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          backgroundImage:
            'linear-gradient(90deg, #020302f2 0%, #020302cc 46%, #02030266 100%), linear-gradient(180deg, var(--color-void) 0%, transparent 18%, transparent 82%, var(--color-void) 100%)',
        }}
      />

      <div className="relative mx-auto max-w-wide px-5 py-32 lg:px-8 lg:py-48">
        <Reveal className="max-w-xl">
          <Eyebrow accent>The other side</Eyebrow>
          <h2 className="font-display text-display mt-6 font-black text-ink uppercase">
            Own
            <br />
            the night.
          </h2>
          <p className="text-lead mt-7 text-ink-secondary">
            Build alliances. Control markets. Create enemies.
          </p>
          <p className="mt-5 max-w-lg leading-relaxed text-ink-muted">
            The underworld in Xenon is structured before it is violent. Crews have identity,
            territory is held socially as much as physically, and every move you make attaches your
            name to something. Reputation is the only currency, and it is spent the moment it is
            used.
          </p>
          <div className="mt-9">
            <Button variant="outline" size="lg" asChild>
              <Link href="/city">
                See how the city works <ArrowRight />
              </Link>
            </Button>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

// --- Community and creators --------------------------------------------------

export function CommunitySection({
  discordInvite,
}: {
  discordInvite: string | null;
}): React.ReactElement {
  return (
    <Section width="wide" size="lg">
      <div className="grid gap-12 lg:grid-cols-2 lg:items-center lg:gap-20">
        <Reveal className="order-2 lg:order-1">
          <MediaSlot
            src={null}
            alt="The Xenon community"
            slot="home.community"
            seed={0}
            className="aspect-3/2 rounded-xl border border-line"
            sizes="(max-width: 1024px) 100vw, 48vw"
          />
        </Reveal>

        <div className="order-1 flex flex-col gap-6 lg:order-2">
          <Eyebrow accent>{communityCopy.eyebrow}</Eyebrow>
          <h2 className="font-display text-headline font-black text-ink uppercase">
            {communityCopy.title}
          </h2>
          <p className="text-lead text-ink-secondary">{communityCopy.body}</p>
          <div className="flex flex-wrap gap-3 pt-2">
            {discordInvite === null ? null : (
              <Button variant="accent" asChild>
                <a href={discordInvite} target="_blank" rel="noopener noreferrer">
                  Join the Discord <ArrowUpRight />
                </a>
              </Button>
            )}
            <Button variant="ghost" asChild>
              <Link href="/community">Community hub</Link>
            </Button>
          </div>
        </div>
      </div>

      <Reveal className="mt-20">
        <Panel tone="raised" pad="none" edgeLight className="overflow-hidden">
          <div className="grid gap-8 p-8 lg:grid-cols-[1.2fr_1fr] lg:items-center lg:p-12">
            <div className="flex flex-col gap-4">
              <Eyebrow>{creatorCopy.eyebrow}</Eyebrow>
              <h3 className="font-display text-title font-bold text-ink">{creatorCopy.title}</h3>
              <p className="max-w-xl leading-relaxed text-ink-secondary">{creatorCopy.body}</p>
            </div>
            <div className="flex lg:justify-end">
              <Button variant="outline" size="lg" asChild>
                <Link href="/support">{creatorCopy.cta}</Link>
              </Button>
            </div>
          </div>
        </Panel>
      </Reveal>
    </Section>
  );
}

// --- Whitelist and Discord CTAs ---------------------------------------------

export function WhitelistCta({ signedIn }: { signedIn: boolean }): React.ReactElement {
  return (
    <Section tone="black" size="lg">
      <Reveal className="flex flex-col items-center gap-7 text-center">
        <Eyebrow accent>{whitelistCopy.eyebrow}</Eyebrow>
        <h2 className="font-display text-display max-w-[14ch] font-black text-ink uppercase">
          {whitelistCopy.title}
        </h2>
        <p className="text-lead max-w-2xl text-ink-secondary">{whitelistCopy.body}</p>
        <div className="flex flex-col gap-3 pt-3 sm:flex-row">
          <Button variant="accent" size="xl" asChild>
            <Link href={signedIn ? '/applications' : '/signin'}>
              {signedIn ? 'Start your application' : 'Sign in with Discord'}
            </Link>
          </Button>
          <Button variant="outline" size="xl" asChild>
            <Link href="/rules">Read the rules first</Link>
          </Button>
        </div>
      </Reveal>
    </Section>
  );
}
