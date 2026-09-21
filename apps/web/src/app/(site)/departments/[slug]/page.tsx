import { ArrowRight, Check } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { prisma } from '@xenon/database';
import { departmentBySlug, publishedDepartments } from '@xenon/domain';
import { Avatar, Badge, Button, Eyebrow, Panel } from '@xenon/ui';
import { Reveal } from '@xenon/ui/motion';

import type { Metadata } from 'next';

import { MediaSlot } from '~/components/media/media-slot';
import { Section } from '~/components/site/section';

export const revalidate = 300;

/**
 * Pre-render the published departments at build time.
 *
 * The list changes a handful of times a year, so this is almost always a cache
 * hit; anything published afterwards is still served, just rendered on demand
 * the first time.
 */
export async function generateStaticParams(): Promise<{ slug: string }[]> {
  const departments = await publishedDepartments(prisma);
  return departments.map((department) => ({ slug: department.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const department = await departmentBySlug(prisma, slug);
  if (department === null) return { title: 'Department' };

  return {
    title: department.name,
    description: department.tagline ?? department.description ?? undefined,
    alternates: { canonical: `/departments/${slug}` },
    openGraph: {
      title: department.name,
      description: department.tagline ?? undefined,
      ...(department.heroImageUrl === null ? {} : { images: [department.heroImageUrl] }),
    },
  };
}

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

const recruitmentNote = {
  OPEN: 'Applications are open. Read the requirements before you start.',
  WAITLIST: 'Not taking new members right now, but you can register interest.',
  INVITE_ONLY: 'Members are invited after a track record in the city.',
  CLOSED: 'This department is not recruiting at the moment.',
} as const;

export default async function DepartmentPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactElement> {
  const { slug } = await params;
  const department = await departmentBySlug(prisma, slug);

  // A draft or archived department is a 404 to the public, not a 403: its
  // existence is not something an outsider should be able to confirm.
  if (department === null) notFound();

  const accent = department.accentColour ?? undefined;

  return (
    <>
      <header className="relative overflow-hidden pt-(--header-height)">
        <MediaSlot
          src={department.heroImageUrl}
          alt=""
          slot={`department.${department.slug}.hero`}
          seed={1}
          priority
          className="absolute inset-0 size-full"
          sizes="100vw"
        />
        <div className="x-cinema-scrim absolute inset-0" aria-hidden />

        <div className="relative mx-auto max-w-content px-5 pt-20 pb-16 lg:px-8 lg:pt-32 lg:pb-24">
          <div className="flex flex-wrap items-center gap-3">
            {department.shortName === null ? null : (
              <span
                className="font-mono text-[0.6875rem] tracking-[0.22em] uppercase"
                style={{ color: accent }}
              >
                {department.shortName}
              </span>
            )}
            <Badge tone={recruitmentTone[department.recruitmentState]}>
              {recruitmentLabel[department.recruitmentState]}
            </Badge>
          </div>

          <h1 className="font-display text-display mt-6 max-w-[16ch] font-black text-ink uppercase">
            {department.name}
          </h1>

          {department.tagline === null ? null : (
            <p className="text-lead mt-6 max-w-2xl text-ink-secondary">{department.tagline}</p>
          )}

          {department.templates.length === 0 ? null : (
            <div className="mt-9 flex flex-wrap gap-3">
              {department.templates.map((template) => (
                <Button key={template.slug} variant="accent" size="lg" asChild>
                  <Link href={`/applications/${template.slug}`}>
                    Apply to {template.name} <ArrowRight />
                  </Link>
                </Button>
              ))}
            </div>
          )}
        </div>
      </header>

      <Section width="content">
        <div className="grid gap-14 lg:grid-cols-[1.6fr_1fr] lg:gap-16">
          <div className="flex flex-col gap-10">
            {department.description === null ? null : (
              <Reveal>
                <p className="text-lead text-ink-secondary">{department.description}</p>
              </Reveal>
            )}

            {department.body === null ? null : (
              <Reveal>
                {/*
                  Stored as HTML that `@xenon/validation` sanitised at parse
                  time. The rendering path has nothing left to decide, which is
                  why this is the only place in the app that sets HTML directly.
                */}
                <div className="x-prose" dangerouslySetInnerHTML={{ __html: department.body }} />
              </Reveal>
            )}

            {department.gallery.length === 0 ? null : (
              <Reveal className="flex flex-col gap-5">
                <Eyebrow accent>In the field</Eyebrow>
                <div className="grid gap-3 sm:grid-cols-2">
                  {department.gallery.slice(0, 4).map((item, index) => (
                    <MediaSlot
                      key={item.id}
                      src={null}
                      alt={item.caption ?? department.name}
                      slot={`department.${department.slug}.gallery.${String(index)}`}
                      seed={index}
                      className="aspect-4/3 rounded-lg border border-line"
                      sizes="(max-width: 640px) 100vw, 40vw"
                    />
                  ))}
                </div>
              </Reveal>
            )}
          </div>

          <aside className="flex flex-col gap-5 lg:sticky lg:top-28 lg:self-start">
            <Panel tone="raised" pad="lg" edgeLight>
              <Eyebrow>Recruitment</Eyebrow>
              <p className="mt-3 text-sm leading-relaxed text-ink-secondary">
                {recruitmentNote[department.recruitmentState]}
              </p>

              {department.requirements.length === 0 ? null : (
                <>
                  <p className="x-eyebrow mt-6">Requirements</p>
                  <ul className="mt-3 flex flex-col gap-2.5">
                    {department.requirements.map((requirement) => (
                      <li
                        key={requirement}
                        className="flex items-start gap-2.5 text-sm text-ink-secondary"
                      >
                        <Check className="mt-0.5 size-3.5 shrink-0 text-xenon" aria-hidden />
                        {requirement}
                      </li>
                    ))}
                  </ul>
                </>
              )}

              <div className="mt-7 flex flex-col gap-2.5">
                {department.templates.length > 0 ? (
                  department.templates.map((template) => (
                    <Button key={template.slug} variant="accent" asChild className="w-full">
                      <Link href={`/applications/${template.slug}`}>Apply now</Link>
                    </Button>
                  ))
                ) : (
                  <Button variant="outline" asChild className="w-full">
                    <Link href="/applications">See all applications</Link>
                  </Button>
                )}
                <Button variant="ghost" asChild className="w-full">
                  <Link href="/support">Ask a question</Link>
                </Button>
              </div>
            </Panel>

            {department.members.length === 0 ? null : (
              <Panel tone="flat" pad="lg">
                <Eyebrow>Leadership</Eyebrow>
                <ul className="mt-4 flex flex-col gap-4">
                  {department.members.map((member) => (
                    <li key={member.id} className="flex items-center gap-3">
                      <Avatar
                        src={member.user.avatarUrl}
                        name={member.user.displayName}
                        size={36}
                      />
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-sm font-medium text-ink">
                          {member.user.displayName ??
                            member.user.discordAccount?.username ??
                            member.user.publicId}
                        </span>
                        {member.rank === null ? null : (
                          <span className="font-mono text-[0.625rem] tracking-[0.14em] text-ink-muted uppercase">
                            {member.rank}
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}
          </aside>
        </div>
      </Section>

      <Section tone="black" size="sm">
        <Link
          href="/departments"
          className="inline-flex items-center gap-2 font-mono text-[0.6875rem] tracking-[0.16em] text-ink-muted uppercase transition-colors hover:text-xenon"
        >
          <ArrowRight className="size-3.5 rotate-180" /> All departments
        </Link>
      </Section>
    </>
  );
}
