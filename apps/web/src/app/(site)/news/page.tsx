import { Pin } from 'lucide-react';
import Link from 'next/link';

import { prisma } from '@xenon/database';
import { publishedArticles } from '@xenon/domain';
import { Badge, EmptyState } from '@xenon/ui';
import { Reveal } from '@xenon/ui/motion';

import type { Metadata } from 'next';

import { MediaSlot } from '~/components/media/media-slot';
import { PageHeader, Section } from '~/components/site/section';

export const metadata: Metadata = {
  title: 'News',
  description: 'Announcements, city news and updates from the XenonRP team.',
  alternates: { canonical: '/news' },
};

export const revalidate = 120;

function formatDate(value: string | null): string {
  if (value === null) return 'Unpublished';
  return new Date(value).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * /news
 *
 * A lead article at full width followed by a dense list. Uniform cards would
 * flatten the difference between "the city is opening" and "a small rule
 * clarification", which is exactly the difference the page exists to show.
 */
export default async function NewsPage(): Promise<React.ReactElement> {
  const articles = await publishedArticles(prisma, 40);
  const [lead, ...rest] = articles;

  return (
    <>
      <PageHeader
        eyebrow="News"
        title={
          <>
            From
            <br />
            the city
          </>
        }
        lead="Announcements, changes and the occasional story worth telling."
      />

      <Section width="wide">
        {articles.length === 0 ? (
          <EmptyState
            title="Nothing published yet"
            description="Articles are written and published from the Xenon control centre. The first one will appear here."
          />
        ) : (
          <div className="flex flex-col gap-16">
            {lead === undefined ? null : (
              <Reveal>
                <Link
                  href={`/news/${lead.slug}`}
                  className="group grid gap-8 lg:grid-cols-2 lg:gap-12"
                >
                  <MediaSlot
                    src={lead.heroImageUrl}
                    alt=""
                    slot="news.index.lead"
                    seed={0}
                    priority
                    className="aspect-16/10 rounded-xl border border-line"
                    sizes="(max-width: 1024px) 100vw, 50vw"
                  />
                  <div className="flex flex-col justify-center gap-4">
                    <div className="flex flex-wrap items-center gap-3">
                      {lead.isPinned ? (
                        <Badge tone="success">
                          <Pin className="size-3" /> Pinned
                        </Badge>
                      ) : null}
                      {lead.category === null ? null : <Badge>{lead.category}</Badge>}
                      <time
                        className="font-mono text-[0.6875rem] tracking-[0.14em] text-ink-muted uppercase"
                        dateTime={lead.publishedAt ?? undefined}
                      >
                        {formatDate(lead.publishedAt)}
                      </time>
                    </div>
                    <h2 className="font-display text-headline font-black text-ink uppercase transition-colors group-hover:text-xenon">
                      {lead.title}
                    </h2>
                    {lead.excerpt === null ? null : (
                      <p className="text-lead text-ink-secondary">{lead.excerpt}</p>
                    )}
                    {lead.authorName === null ? null : (
                      <p className="x-eyebrow">By {lead.authorName}</p>
                    )}
                  </div>
                </Link>
              </Reveal>
            )}

            {rest.length === 0 ? null : (
              <div className="flex flex-col divide-y divide-line border-y border-line">
                {rest.map((article, index) => (
                  <Reveal key={article.slug} delay={Math.min(index, 6) * 0.03}>
                    <Link
                      href={`/news/${article.slug}`}
                      className="group grid gap-4 py-7 lg:grid-cols-[9rem_1fr_auto] lg:items-baseline lg:gap-10"
                    >
                      <time
                        className="font-mono text-[0.6875rem] tracking-[0.14em] text-ink-muted uppercase"
                        dateTime={article.publishedAt ?? undefined}
                      >
                        {formatDate(article.publishedAt)}
                      </time>

                      <div className="flex flex-col gap-2">
                        <h3 className="font-display text-xl leading-snug font-bold text-ink transition-colors group-hover:text-xenon">
                          {article.title}
                        </h3>
                        {article.excerpt === null ? null : (
                          <p className="max-w-2xl text-sm leading-relaxed text-ink-muted">
                            {article.excerpt}
                          </p>
                        )}
                      </div>

                      {article.category === null ? null : (
                        <Badge tone="chrome" className="justify-self-start lg:justify-self-end">
                          {article.category}
                        </Badge>
                      )}
                    </Link>
                  </Reveal>
                ))}
              </div>
            )}
          </div>
        )}
      </Section>
    </>
  );
}
