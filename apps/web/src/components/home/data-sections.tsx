import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

import type { PublicArticleSummary, PublicDepartment } from '@xenon/domain';
import { Badge, Button, cn, EmptyState, Panel } from '@xenon/ui';
import { Reveal, Stagger, StaggerItem } from '@xenon/ui/motion';

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
              <Link
                href={`/departments/${department.slug}`}
                className="group block h-full overflow-hidden rounded-lg border border-line bg-surface transition-colors duration-(--duration-base) hover:border-chrome-500"
              >
                <MediaSlot
                  src={department.heroImageUrl}
                  alt=""
                  slot={`department.${department.slug}`}
                  seed={index}
                  className="aspect-16/10"
                  sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                />
                <div className="flex flex-col gap-3 p-6">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="font-display text-lg font-bold text-ink transition-colors group-hover:text-xenon">
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
              <MediaSlot
                src={lead.heroImageUrl}
                alt=""
                slot="news.lead"
                seed={0}
                className="aspect-16/9 rounded-lg border border-line"
                sizes="(max-width: 1024px) 100vw, 56vw"
              />
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
                <h3 className="font-display text-title font-bold text-ink transition-colors group-hover:text-xenon">
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
                <h3 className="font-display text-lg leading-snug font-bold text-ink transition-colors group-hover:text-xenon">
                  {article.title}
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

// --- Statistics --------------------------------------------------------------

export interface CityStatistic {
  readonly label: string;
  readonly value: number;
  readonly caption: string;
}

/**
 * Real statistics.
 *
 * Every figure is a `count()` against this database. There are no testimonials,
 * no "10,000+ members", and no rounded-up numbers - if the community is small,
 * the page says the true small number, and that is worth more than a claim a
 * visitor can disprove by joining the Discord.
 */
export function RealStatistics({
  statistics,
}: {
  statistics: readonly CityStatistic[];
}): React.ReactElement | null {
  const meaningful = statistics.filter((statistic) => statistic.value > 0);
  // A wall of zeros on a fresh install says nothing; the section simply does
  // not exist until there is something true to put in it.
  if (meaningful.length === 0) return null;

  // The column count follows the number of figures. A four-column grid holding
  // one statistic stretches it across the width of the page and reads as a
  // layout bug rather than as a young community.
  const columns =
    meaningful.length === 1
      ? 'grid-cols-1'
      : meaningful.length === 2
        ? 'sm:grid-cols-2'
        : meaningful.length === 3
          ? 'sm:grid-cols-3'
          : 'sm:grid-cols-2 lg:grid-cols-4';

  return (
    <Section width="wide" size="md">
      <Panel tone="raised" pad="none" edgeLight className="overflow-hidden">
        <dl className={cn('grid gap-px bg-line', columns)}>
          {meaningful.map((statistic) => (
            <div key={statistic.label} className="flex flex-col gap-1.5 bg-elevated p-8">
              <dt className="x-eyebrow">{statistic.label}</dt>
              <dd className="x-tabular font-display text-5xl leading-none font-black text-ink">
                {statistic.value.toLocaleString('en-GB')}
              </dd>
              <p className="text-xs text-ink-muted">{statistic.caption}</p>
            </div>
          ))}
        </dl>
      </Panel>
    </Section>
  );
}
