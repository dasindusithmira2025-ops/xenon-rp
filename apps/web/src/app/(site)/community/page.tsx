import { ArrowRight, ArrowUpRight } from 'lucide-react';
import Link from 'next/link';

import { prisma } from '@xenon/database';
import { allSettings, publishedArticles, publishedDepartments } from '@xenon/domain';
import { Button, Eyebrow, Panel } from '@xenon/ui';
import { Reveal, Stagger, StaggerItem } from '@xenon/ui/motion';

import type { Metadata } from 'next';

import { MediaSlot } from '~/components/media/media-slot';
import { PageHeader, Section, SectionHeading } from '~/components/site/section';
import { communityCopy, creatorCopy } from '~/content/marketing';

export const metadata: Metadata = {
  title: 'Community',
  description:
    'The people behind XenonRP: the Discord, the departments, the creators and the news worth catching up on.',
  alternates: { canonical: '/community' },
};

export const revalidate = 300;

/**
 * /community
 *
 * Deliberately free of invented social proof. There are no testimonials, no
 * member counts pulled out of the air and no fabricated "featured streamers" -
 * the page links to the things that genuinely exist and says so plainly when
 * something is not configured yet.
 */
export default async function CommunityPage(): Promise<React.ReactElement> {
  const [settings, departments, articles] = await Promise.all([
    allSettings(prisma),
    publishedDepartments(prisma),
    publishedArticles(prisma, 3),
  ]);

  const invite = settings['community.discordInvite'];
  const discordInvite = invite !== undefined && invite.length > 0 ? invite : null;

  const socials = (
    [
      ['YouTube', settings['community.youtube']],
      ['TikTok', settings['community.tiktok']],
      ['Instagram', settings['community.instagram']],
    ] as const
  ).flatMap(([label, href]) => (href !== undefined && href.length > 0 ? [{ label, href }] : []));

  return (
    <>
      <PageHeader
        eyebrow={communityCopy.eyebrow}
        title={
          <>
            The people
            <br />
            in it
          </>
        }
        lead={communityCopy.body}
      >
        {discordInvite === null ? null : (
          <div className="mt-8">
            <Button variant="accent" size="lg" asChild>
              <a href={discordInvite} target="_blank" rel="noopener noreferrer">
                Join the Discord <ArrowUpRight />
              </a>
            </Button>
          </div>
        )}
      </PageHeader>

      <Section width="wide">
        <div className="grid gap-12 lg:grid-cols-2 lg:items-center lg:gap-20">
          <Reveal>
            <MediaSlot
              src={null}
              alt="The Xenon community"
              slot="community.hero"
              seed={0}
              className="aspect-4/3 rounded-xl border border-line"
              sizes="(max-width: 1024px) 100vw, 48vw"
            />
          </Reveal>

          <div className="flex flex-col gap-6">
            <Eyebrow accent>Where it happens</Eyebrow>
            <h2 className="font-display text-headline font-black text-ink uppercase">
              Discord is the front door
            </h2>
            <p className="text-lead text-ink-secondary">
              Applications, support, department recruitment and most of the planning happen in the
              Xenon Discord. Your account here is the same account there.
            </p>

            {discordInvite === null ? (
              <Panel tone="ghost" className="border-warning/30 bg-warning/5">
                <p className="text-sm text-warning">
                  No Discord invite is configured yet. Staff can set one from the control centre
                  under Settings.
                </p>
              </Panel>
            ) : (
              <div className="flex flex-wrap gap-3">
                <Button variant="accent" asChild>
                  <a href={discordInvite} target="_blank" rel="noopener noreferrer">
                    Open Discord <ArrowUpRight />
                  </a>
                </Button>
                {socials.map((social) => (
                  <Button key={social.href} variant="outline" asChild>
                    <a href={social.href} target="_blank" rel="noopener noreferrer">
                      {social.label} <ArrowUpRight />
                    </a>
                  </Button>
                ))}
              </div>
            )}
          </div>
        </div>
      </Section>

      {departments.length === 0 ? null : (
        <Section tone="black" width="wide">
          <SectionHeading
            eyebrow="Organisations"
            title="Groups worth joining"
            lead="Every department here is run by players, with its own training and command."
            action={
              <Button variant="outline" asChild>
                <Link href="/departments">
                  All departments <ArrowRight />
                </Link>
              </Button>
            }
          />

          <Stagger className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {departments.slice(0, 6).map((department) => (
              <StaggerItem key={department.slug}>
                <Link
                  href={`/departments/${department.slug}`}
                  className="group flex h-full flex-col gap-3 rounded-lg border border-line bg-surface p-6 transition-colors hover:border-chrome-500"
                >
                  <p className="x-eyebrow" style={{ color: department.accentColour ?? undefined }}>
                    {department.shortName ?? 'Department'}
                  </p>
                  <h3 className="font-display text-lg font-bold text-ink transition-colors group-hover:text-xenon">
                    {department.name}
                  </h3>
                  {department.tagline === null ? null : (
                    <p className="text-sm leading-relaxed text-ink-muted">{department.tagline}</p>
                  )}
                </Link>
              </StaggerItem>
            ))}
          </Stagger>
        </Section>
      )}

      <Section width="wide">
        <Panel tone="raised" pad="none" edgeLight className="overflow-hidden">
          <div className="grid gap-8 p-8 lg:grid-cols-[1.3fr_1fr] lg:items-center lg:p-14">
            <div className="flex flex-col gap-4">
              <Eyebrow accent>{creatorCopy.eyebrow}</Eyebrow>
              <h2 className="font-display text-title font-black text-ink uppercase">
                {creatorCopy.title}
              </h2>
              <p className="max-w-xl leading-relaxed text-ink-secondary">{creatorCopy.body}</p>
              <p className="text-sm text-ink-muted">
                We do not publish a creator list until there is one worth publishing. If you make
                content in Xenon, open a ticket and we will sort out access properly.
              </p>
            </div>
            <div className="flex lg:justify-end">
              <Button variant="accent" size="lg" asChild>
                <Link href="/support">{creatorCopy.cta}</Link>
              </Button>
            </div>
          </div>
        </Panel>
      </Section>

      {articles.length === 0 ? null : (
        <Section tone="black" width="wide" size="md">
          <SectionHeading
            eyebrow="Catch up"
            title="Recent news"
            action={
              <Button variant="outline" asChild>
                <Link href="/news">
                  All news <ArrowRight />
                </Link>
              </Button>
            }
          />
          <div className="mt-10 flex flex-col divide-y divide-line border-y border-line">
            {articles.map((article) => (
              <Link
                key={article.slug}
                href={`/news/${article.slug}`}
                className="group flex flex-col gap-1.5 py-5"
              >
                <time
                  className="font-mono text-[0.625rem] tracking-[0.14em] text-ink-muted uppercase"
                  dateTime={article.publishedAt ?? undefined}
                >
                  {article.publishedAt === null
                    ? 'Unpublished'
                    : new Date(article.publishedAt).toLocaleDateString('en-GB', {
                        day: '2-digit',
                        month: 'short',
                        year: 'numeric',
                      })}
                </time>
                <h3 className="font-display text-lg font-bold text-ink transition-colors group-hover:text-xenon">
                  {article.title}
                </h3>
              </Link>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}
