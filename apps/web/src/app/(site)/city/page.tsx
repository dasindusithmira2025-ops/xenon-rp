import { ArrowRight, Check } from 'lucide-react';
import Link from 'next/link';

import { Button, Eyebrow, Panel } from '@xenon/ui';
import { Parallax, Reveal, Stagger, StaggerItem } from '@xenon/ui/motion';

import type { Metadata } from 'next';

import { MediaSlot } from '~/components/media/media-slot';
import { PageHeader, Section, SectionHeading } from '~/components/site/section';
import { cityFacets, citySystems, storyPaths } from '~/content/marketing';

export const metadata: Metadata = {
  title: 'Life in the city',
  description:
    'What it is like to play in Xenon: the streets, the work, the law and the nights. A Sri Lankan FiveM roleplay city built on consequence.',
  alternates: { canonical: '/city' },
};

/**
 * /city
 *
 * The page that answers "what is it actually like". Alternates side, so the
 * four facets read as a sequence rather than as four identical rows, and the
 * media sits on the opposite side each time.
 *
 * Nothing here claims a mechanic. The copy lives in `~/content/marketing` and
 * is written about roleplay as a form, so an owner can rewrite it without
 * anybody having to check which sentences were promises.
 */
export const revalidate = 3600;

export default function CityPage(): React.ReactElement {
  return (
    <>
      <PageHeader
        eyebrow="Life in Xenon"
        title={
          <>
            A city with
            <br />a memory
          </>
        }
        lead="Xenon is not a map with jobs bolted to it. It is a place where the same people keep showing up, and where what happened last month is still true this month."
      >
        <div className="mt-9 flex flex-wrap gap-3">
          <Button variant="accent" size="lg" asChild>
            <Link href="/applications">
              Apply for whitelist <ArrowRight />
            </Link>
          </Button>
          <Button variant="outline" size="lg" asChild>
            <Link href="/rules">Read the rulebook</Link>
          </Button>
        </div>
      </PageHeader>

      {cityFacets.map((facet, index) => (
        <Section key={facet.eyebrow} tone={index % 2 === 0 ? 'void' : 'black'} width="wide">
          <div className="grid gap-12 lg:grid-cols-2 lg:items-center lg:gap-20">
            <Reveal className={index % 2 === 0 ? 'lg:order-2' : ''}>
              <Parallax strength={0.08} className="aspect-4/3 rounded-xl border border-line">
                <MediaSlot
                  src={null}
                  alt={facet.title}
                  slot={`city.${facet.eyebrow.toLowerCase()}`}
                  seed={index}
                  className="size-full"
                  sizes="(max-width: 1024px) 100vw, 48vw"
                />
              </Parallax>
            </Reveal>

            <div className="flex flex-col gap-6">
              <Eyebrow accent>{facet.eyebrow}</Eyebrow>
              <h2 className="font-display text-headline font-black text-ink uppercase">
                {facet.title}
              </h2>
              <p className="text-lead text-ink-secondary">{facet.body}</p>
              <ul className="mt-2 flex flex-col gap-3">
                {facet.points.map((point) => (
                  <li key={point} className="flex items-start gap-3 text-sm text-ink-secondary">
                    <Check className="mt-0.5 size-4 shrink-0 text-xenon" aria-hidden />
                    {point}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Section>
      ))}

      <Section width="wide" tone="surface">
        <SectionHeading
          eyebrow="Ways to play"
          title="Pick a direction"
          lead="None of these are locked. They are the shapes a life in Xenon tends to take."
        />

        <Stagger className="mt-12 grid gap-px overflow-hidden rounded-lg border border-line bg-line lg:grid-cols-5">
          {storyPaths.map((path) => (
            <StaggerItem key={path.key} className="flex flex-col gap-3 bg-surface p-6">
              <p className="x-eyebrow text-xenon">{path.label}</p>
              <h3 className="font-display text-base leading-snug font-bold text-ink">
                {path.headline}
              </h3>
              <p className="text-sm leading-relaxed text-ink-muted">{path.body}</p>
            </StaggerItem>
          ))}
        </Stagger>
      </Section>

      <Section width="wide">
        <SectionHeading
          eyebrow="Foundations"
          title="What everything else depends on"
          align="center"
        />
        <Stagger className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {citySystems.map((system) => (
            <StaggerItem key={system.title}>
              <Panel tone="flat" pad="lg" edgeLight className="h-full">
                <h3 className="font-display text-lg font-bold text-ink">{system.title}</h3>
                <p className="mt-2.5 text-sm leading-relaxed text-ink-secondary">{system.body}</p>
              </Panel>
            </StaggerItem>
          ))}
        </Stagger>
      </Section>

      <Section tone="black" size="lg">
        <Reveal className="flex flex-col items-center gap-7 text-center">
          <Eyebrow accent>Next</Eyebrow>
          <h2 className="font-display text-display max-w-[16ch] font-black text-ink uppercase">
            Come and find out
          </h2>
          <p className="text-lead max-w-xl text-ink-secondary">
            The application asks who your character is and how you intend to play them. It is read
            by a person, and you get a real answer.
          </p>
          <div className="flex flex-col gap-3 pt-2 sm:flex-row">
            <Button variant="accent" size="xl" asChild>
              <Link href="/applications">Start an application</Link>
            </Button>
            <Button variant="outline" size="xl" asChild>
              <Link href="/departments">See the departments</Link>
            </Button>
          </div>
        </Reveal>
      </Section>
    </>
  );
}
