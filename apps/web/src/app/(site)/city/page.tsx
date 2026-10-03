import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

import { Button, Eyebrow, Panel } from '@xenon/ui';
import { Reveal, Stagger, StaggerItem } from '@xenon/ui/motion';

import type { Metadata } from 'next';

import { CityChapters } from '~/components/city/city-chapters';
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
 * The page that answers "what is it actually like". The facets alternate side,
 * so they read as a sequence rather than as four identical rows, and a rail
 * down the edge of the viewport marks which one the reader is in - the page is
 * tall enough that "how far through am I" is a real question.
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

      <CityChapters facets={cityFacets} />

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
