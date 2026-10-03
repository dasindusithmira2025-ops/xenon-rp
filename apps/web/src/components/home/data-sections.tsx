import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

import type { PublicArticleSummary, PublicDepartment } from '@xenon/domain';
import { Badge, Button, EmptyState } from '@xenon/ui';
import { MediaReveal, Reveal, Stagger, StaggerItem } from '@xenon/ui/motion';

import { MediaSlot } from '~/components/media/media-slot';
import { Section, SectionHeading } from '~/components/site/section';

/**
 * Homepage sections driven by real data.
 *
 * Each one renders an honest empty state rather than fixture content when the
 * database has nothing yet. A brand new install should look deliberately empty,
 * not populated with departments that do not exist.
 */

// --- Departments -------------------------------------------------------------

const recruitmentTone = {
  OPEN: 'success',
  WAITLIST: 'warning',
  INVITE_ONLY: 'info',
  CLOSED: 'neutral',
} as const;

const recruitmentLabel = {
  OPEN: 'Recruiting',
  WAITLIST: 'Waitlist',
  INVITE_ONLY: 'Invite only',
  CLOSED: 'Closed',
} as const;

export function DepartmentsStrip({
  departments,
}: {
  departments: readonly PublicDepartment[];
}): React.ReactElement {
  return (
    <Section width="wide" size="lg">
      <SectionHeading
        eyebrow="Departments"
        title="Serve the city"
        lead="Whitelisted organisations run by players, with their own standards, training and command."
        action={
          <Button variant="outline" asChild>
            <Link href="/departments">
              All departments <ArrowRight />
            </Link>
          </Button>
        }
      />

      {departments.length === 0 ? (
        <EmptyState
          className="mt-12"
          title="No departments published yet"
          description="Departments are configured from the control centre. Once published they appear here."
        />
      ) : (
        <Stagger className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {departments.slice(0, 6).map((department, index) => (
            <StaggerItem key={department.slug}>
              {/*
                Editorial card hover: the image pushes in slightly, an accent
                hairline draws across the top of the caption, and the title
                takes the accent. Three small things moving together read as one
                object responding - which is the difference between a card that
                lifts off the page on a shadow and a card that feels like a
                surface being pressed.
              */}
              <Link
                href={`/departments/${department.slug}`}
                className="group relative block h-full overflow-hidden rounded-lg border border-line bg-surface transition-colors duration-(--duration-base) hover:border-chrome-500"
              >
                <div className="relative overflow-hidden">
                  <MediaSlot
                    src={department.heroImageUrl}
                    alt=""
                    slot={`department.${department.slug}`}
                    seed={index}
                    className="aspect-16/10 transition-transform duration-(--duration-slow) ease-standard group-hover:scale-[1.04] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
                    sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                  />
                  {/* Anchored to the foot of the image rather than to a
                      percentage of the card: the caption below it grows with
                      the tagline, and a hairline positioned by fraction would
                      drift across the photograph as the text wrapped. */}
                  <span
                    aria-hidden
                    className="absolute inset-x-0 bottom-0 h-px origin-left scale-x-0 bg-xenon transition-transform duration-(--duration-base) ease-standard group-hover:scale-x-100"
                  />
                </div>
                <div className="flex flex-col gap-3 p-6">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="font-display text-lg font-bold text-ink transition-colors duration-(--duration-fast) group-hover:text-xenon">
                      {department.name}
                    </h3>
                    <Badge tone={recruitmentTone[department.recruitmentState]}>
                      {recruitmentLabel[department.recruitmentState]}
                    </Badge>
                  </div>
                  {department.tagline === null ? null : (
                    <p className="text-sm leading-relaxed text-ink-secondary">
                      {department.tagline}
                    </p>
                  )}
                </div>
              </Link>
            </StaggerItem>
          ))}
        </Stagger>
      )}
    </Section>
  );
}

// --- News --------------------------------------------------------------------

export function LatestNews({
  articles,
}: {
  articles: readonly PublicArticleSummary[];
}): React.ReactElement {
  if (articles.length === 0) {
    return (
      <Section tone="black" width="wide">
        <SectionHeading eyebrow="News" title="Nothing published yet" />
        <EmptyState
          className="mt-10"
          title="The newsroom is quiet"
          description="Announcements and city news will appear here once staff publish the first article."
        />
      </Section>
    );
  }

  const [lead, ...rest] = articles;

  return (
    <Section tone="black" width="wide" size="lg">
      <SectionHeading
        eyebrow="Latest"
        title="From the city"
        action={
          <Button variant="outline" asChild>
            <Link href="/news">
              All news <ArrowRight />
            </Link>
          </Button>
        }
      />

      <div className="mt-14 grid gap-8 lg:grid-cols-[1.35fr_1fr] lg:gap-12">
        {lead === undefined ? null : (
          <Reveal>
            <Link href={`/news/${lead.slug}`} className="group block">
              <MediaReveal className="aspect-16/9 rounded-lg border border-line">
                <MediaSlot
                  src={lead.heroImageUrl}
                  alt=""
                  slot="news.lead"
                  seed={0}
                  className="size-full transition-transform duration-(--duration-slow) ease-standard group-hover:scale-[1.03] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
                  sizes="(max-width: 1024px) 100vw, 56vw"
                />
              </MediaReveal>
              <div className="mt-6 flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  {lead.category === null ? null : <Badge>{lead.category}</Badge>}
                  <time
                    className="font-mono text-[0.6875rem] tracking-[0.14em] text-ink-muted uppercase"
                    dateTime={lead.publishedAt ?? undefined}
                  >
                    {formatDate(lead.publishedAt)}
                  </time>
                </div>
                <h3 className="font-display text-title font-bold text-ink transition-colors duration-(--duration-fast) group-hover:text-xenon">
                  {lead.title}
                </h3>
                {lead.excerpt === null ? null : (
                  <p className="leading-relaxed text-ink-secondary">{lead.excerpt}</p>
                )}
              </div>
            </Link>
          </Reveal>
        )}

        <div className="flex flex-col divide-y divide-line border-t border-line lg:border-t-0">
          {rest.slice(0, 4).map((article, index) => (
            <Reveal key={article.slug} delay={index * 0.05}>
              <Link href={`/news/${article.slug}`} className="group flex flex-col gap-2 py-6">
                <time
                  className="font-mono text-[0.6875rem] tracking-[0.14em] text-ink-muted uppercase"
                  dateTime={article.publishedAt ?? undefined}
                >
                  {formatDate(article.publishedAt)}
                </time>
                <h3 className="font-display flex items-start gap-2 text-lg leading-snug font-bold text-ink transition-colors duration-(--duration-fast) group-hover:text-xenon">
                  {article.title}
                  {/* The arrow travels 3px on hover. Small enough that it reads
                      as the row acknowledging the pointer rather than as a
                      separate thing sliding about. */}
                  <ArrowRight className="mt-1 size-4 shrink-0 -translate-x-1 opacity-0 transition-[transform,opacity] duration-(--duration-fast) ease-standard group-hover:translate-x-0 group-hover:opacity-100" />
                </h3>
                {article.excerpt === null ? null : (
                  <p className="line-clamp-2 text-sm text-ink-muted">{article.excerpt}</p>
                )}
              </Link>
            </Reveal>
          ))}
        </div>
      </div>
    </Section>
  );
}

function formatDate(value: string | null): string {
  if (value === null) return 'Unpublished';
  return new Date(value).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}
