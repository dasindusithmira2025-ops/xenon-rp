import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { prisma } from '@xenon/database';
import { publishedArticleBySlug, publishedArticles } from '@xenon/domain';
import { Avatar, Badge, Button } from '@xenon/ui';
import { ScrollProgress } from '@xenon/ui/motion';

import type { Metadata } from 'next';

import { MediaSlot } from '~/components/media/media-slot';
import { Section } from '~/components/site/section';

export const revalidate = 300;

export async function generateStaticParams(): Promise<{ slug: string }[]> {
  const articles = await publishedArticles(prisma, 50);
  return articles.map((article) => ({ slug: article.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const article = await publishedArticleBySlug(prisma, slug);
  if (article === null) return { title: 'Article' };

  return {
    title: article.title,
    description: article.excerpt ?? undefined,
    alternates: { canonical: `/news/${slug}` },
    openGraph: {
      type: 'article',
      title: article.title,
      description: article.excerpt ?? undefined,
      publishedTime: article.publishedAt?.toISOString(),
      ...(article.heroImageUrl === null ? {} : { images: [article.heroImageUrl] }),
    },
  };
}

export default async function ArticlePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactElement> {
  const { slug } = await params;
  const article = await publishedArticleBySlug(prisma, slug);

  // Drafts and future-dated articles are 404 rather than visible-with-a-badge.
  if (article === null) notFound();

  const more = (await publishedArticles(prisma, 4)).filter((candidate) => candidate.slug !== slug);

  return (
    <>
      <ScrollProgress />

      <article>
        <header className="relative overflow-hidden border-b border-line pt-(--header-height)">
          <MediaSlot
            src={article.heroImageUrl}
            alt=""
            slot={`news.${slug}.hero`}
            seed={1}
            priority
            className="absolute inset-0 size-full"
            sizes="100vw"
          />
          <div className="x-cinema-scrim absolute inset-0" aria-hidden />

          <div className="relative mx-auto max-w-3xl px-5 pt-16 pb-14 lg:pt-24 lg:pb-20">
            <Link
              href="/news"
              className="inline-flex items-center gap-2 font-mono text-[0.6875rem] tracking-[0.16em] text-ink-muted uppercase transition-colors hover:text-xenon"
            >
              <ArrowLeft className="size-3.5" /> All news
            </Link>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              {article.category === null ? null : <Badge>{article.category}</Badge>}
              <time
                className="font-mono text-[0.6875rem] tracking-[0.14em] text-ink-muted uppercase"
                dateTime={article.publishedAt?.toISOString()}
              >
                {article.publishedAt?.toLocaleDateString('en-GB', {
                  day: '2-digit',
                  month: 'long',
                  year: 'numeric',
                }) ?? 'Unpublished'}
              </time>
            </div>

            <h1 className="font-display text-headline mt-5 font-black text-ink uppercase">
              {article.title}
            </h1>

            {article.excerpt === null ? null : (
              <p className="text-lead mt-5 text-ink-secondary">{article.excerpt}</p>
            )}

            {article.author === null ? null : (
              <div className="mt-8 flex items-center gap-3">
                <Avatar
                  src={article.author.avatarUrl}
                  name={article.author.displayName}
                  size={36}
                />
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-ink">
                    {article.author.displayName ?? article.author.publicId}
                  </span>
                  <span className="x-eyebrow">Xenon staff</span>
                </div>
              </div>
            )}
          </div>
        </header>

        <Section width="content" size="md">
          <div className="mx-auto max-w-3xl">
            {/*
              Sanitised at parse time in `@xenon/validation`, which is the only
              reason setting HTML here is acceptable. Nothing that was not
              written through the editor can reach this string.
            */}
            <div className="x-prose" dangerouslySetInnerHTML={{ __html: article.body }} />

            {article.tags.length === 0 ? null : (
              <div className="mt-12 flex flex-wrap gap-2 border-t border-line pt-8">
                {article.tags.map((tag) => (
                  <Badge key={tag} tone="chrome">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </Section>
      </article>

      {more.length === 0 ? null : (
        <Section tone="black" width="wide" size="md">
          <p className="x-eyebrow">Keep reading</p>
          <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {more.slice(0, 3).map((item, index) => (
              <Link
                key={item.slug}
                href={`/news/${item.slug}`}
                className="group flex flex-col gap-4"
              >
                <MediaSlot
                  src={item.heroImageUrl}
                  alt=""
                  slot={`news.${item.slug}.thumb`}
                  seed={index}
                  className="aspect-16/9 rounded-lg border border-line"
                  sizes="(max-width: 640px) 100vw, 33vw"
                />
                <h3 className="font-display text-base leading-snug font-bold text-ink transition-colors group-hover:text-xenon">
                  {item.title}
                </h3>
              </Link>
            ))}
          </div>

          <div className="mt-10">
            <Button variant="outline" asChild>
              <Link href="/news">All news</Link>
            </Button>
          </div>
        </Section>
      )}
    </>
  );
}
