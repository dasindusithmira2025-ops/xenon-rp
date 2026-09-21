import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

import { prisma } from '@xenon/database';
import { publishedDepartments } from '@xenon/domain';
import { Badge, Button, EmptyState } from '@xenon/ui';
import { Reveal } from '@xenon/ui/motion';

import type { Metadata } from 'next';

import { MediaSlot } from '~/components/media/media-slot';
import { PageHeader, Section } from '~/components/site/section';

export const metadata: Metadata = {
  title: 'Departments',
  description:
    'The player-run organisations that keep Xenon running: police, emergency medical, justice, mechanics and businesses.',
  alternates: { canonical: '/departments' },
};

export const revalidate = 300;

const recruitmentTone = {
  OPEN: 'success',
  WAITLIST: 'warning',
  INVITE_ONLY: 'info',
  CLOSED: 'neutral',
} as const;

const recruitmentLabel = {
  OPEN: 'Recruiting now',
  WAITLIST: 'Waitlist open',
  INVITE_ONLY: 'Invite only',
  CLOSED: 'Not recruiting',
} as const;

/**
 * /departments
 *
 * Entirely data-driven. Adding a department is a row and some copy from the
 * control centre, never a new route - which is the only way this page stays
 * correct as the community reorganises.
 *
 * The list alternates between a wide feature row and a pair, so five
 * departments do not render as five identical cards.
 */
export default async function DepartmentsPage(): Promise<React.ReactElement> {
  const departments = await publishedDepartments(prisma);

  const openCount = departments.filter(
    (department) => department.recruitmentState === 'OPEN',
  ).length;

  return (
    <>
      <PageHeader
        eyebrow="Departments"
        title={
          <>
            Serve
            <br />
            the city
          </>
        }
        lead="Whitelisted organisations with their own standards, training and command structure. Every one of them is run by players."
      >
        {departments.length === 0 ? null : (
          <p className="mt-8 font-mono text-[0.6875rem] tracking-[0.16em] text-ink-muted uppercase">
            {departments.length} published ·{' '}
            <span className={openCount > 0 ? 'text-xenon' : undefined}>{openCount} recruiting</span>
          </p>
        )}
      </PageHeader>

      <Section width="wide">
        {departments.length === 0 ? (
          <EmptyState
            title="No departments published yet"
            description="Departments are created and published from the Xenon control centre. Once staff publish one it appears here automatically."
            action={
              <Button variant="outline" asChild>
                <Link href="/applications">See open applications</Link>
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col gap-5">
            {departments.map((department, index) => {
              // The first department, and every third after it, gets the full
              // width. It breaks the grid rhythm without needing a second
              // component.
              const featured = index % 3 === 0;

              return (
                <Reveal key={department.slug} delay={(index % 3) * 0.05}>
                  <Link
                    href={`/departments/${department.slug}`}
                    className="group relative grid overflow-hidden rounded-xl border border-line bg-surface transition-colors duration-(--duration-base) hover:border-chrome-500 lg:grid-cols-[1.1fr_1fr]"
                  >
                    <MediaSlot
                      src={department.heroImageUrl}
                      alt=""
                      slot={`department.${department.slug}`}
                      seed={index}
                      className={
                        featured ? 'aspect-21/9 lg:aspect-auto' : 'aspect-16/9 lg:aspect-auto'
                      }
                      sizes="(max-width: 1024px) 100vw, 55vw"
                    />

                    <div className="flex flex-col justify-center gap-4 p-7 lg:p-12">
                      <div className="flex flex-wrap items-center gap-3">
                        {department.shortName === null ? null : (
                          <span
                            className="font-mono text-[0.625rem] tracking-[0.2em] uppercase"
                            style={{ color: department.accentColour ?? undefined }}
                          >
                            {department.shortName}
                          </span>
                        )}
                        <Badge tone={recruitmentTone[department.recruitmentState]}>
                          {recruitmentLabel[department.recruitmentState]}
                        </Badge>
                      </div>

                      <h2 className="font-display text-title font-black text-ink uppercase transition-colors group-hover:text-xenon">
                        {department.name}
                      </h2>

                      {department.tagline === null ? null : (
                        <p className="text-lead text-ink-secondary">{department.tagline}</p>
                      )}

                      {department.description === null ? null : (
                        <p className="text-sm leading-relaxed text-ink-muted">
                          {department.description}
                        </p>
                      )}

                      <span className="mt-2 inline-flex items-center gap-2 font-mono text-[0.6875rem] tracking-[0.16em] text-ink-secondary uppercase transition-colors group-hover:text-xenon">
                        Open department <ArrowRight className="size-3.5" />
                      </span>
                    </div>
                  </Link>
                </Reveal>
              );
            })}
          </div>
        )}
      </Section>
    </>
  );
}
