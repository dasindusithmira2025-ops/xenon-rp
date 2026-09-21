import { Check, Clock, FileText, Lock, X } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { checkEligibility, templateOpenState } from '@xenon/applications';
import { prisma } from '@xenon/database';
import { setting } from '@xenon/domain';
import { Badge, Button, Eyebrow, Panel } from '@xenon/ui';

import type { Metadata } from 'next';

import { StartApplicationButton } from '~/components/applications/start-button';
import { PageHeader, Section } from '~/components/site/section';
import { currentActor } from '~/server/context';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const template = await prisma.applicationTemplate.findUnique({ where: { slug } });
  if (template === null) return { title: 'Application' };

  return {
    title: template.name,
    description: template.summary ?? undefined,
    alternates: { canonical: `/applications/${slug}` },
  };
}

/**
 * /applications/[slug]
 *
 * The page between "I want to apply" and a half-written draft. It exists so
 * nobody starts a forty-minute form only to discover on submit that they needed
 * to link FiveM first - every requirement is shown, met or unmet, before the
 * button is offered.
 */
export default async function ApplicationDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactElement> {
  const { slug } = await params;

  const [template, actor] = await Promise.all([
    prisma.applicationTemplate.findUnique({
      where: { slug },
      include: {
        department: { select: { name: true, slug: true } },
        sections: {
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            title: true,
            description: true,
            _count: { select: { questions: true } },
          },
        },
      },
    }),
    currentActor(),
  ]);

  // Drafts and archived templates do not exist as far as the public is
  // concerned. A 403 would confirm that a hidden intake is being prepared.
  if (template === null || template.status === 'DRAFT' || template.status === 'ARCHIVED') {
    notFound();
  }

  const globallyOpen = (await setting(prisma, 'applications.globallyOpen')) !== 'false';
  const openState = templateOpenState(template, globallyOpen);
  const eligibility = await checkEligibility(prisma, template, actor.userId, { globallyOpen });

  const existing =
    actor.userId === null
      ? null
      : await prisma.applicationSubmission.findFirst({
          where: {
            templateId: template.id,
            applicantId: actor.userId,
            status: { in: ['DRAFT', 'CHANGES_REQUESTED'] },
          },
          orderBy: { createdAt: 'desc' },
          select: { publicId: true, status: true },
        });

  const questionCount = template.sections.reduce(
    (total, section) => total + section._count.questions,
    0,
  );

  return (
    <>
      <PageHeader eyebrow={template.department?.name ?? 'Application'} title={template.name}>
        <div className="mt-6 flex flex-wrap items-center gap-2.5">
          <Badge tone={openState.open ? 'success' : 'neutral'}>
            {openState.open ? 'Open' : 'Closed'}
          </Badge>
          {template.grantsWhitelist ? <Badge tone="info">Grants whitelist</Badge> : null}
          {template.interviewRequired ? <Badge tone="warning">Interview stage</Badge> : null}
        </div>

        {template.summary === null ? null : (
          <p className="text-lead mt-6 max-w-2xl text-ink-secondary">{template.summary}</p>
        )}
      </PageHeader>

      <Section width="content">
        <div className="grid gap-12 lg:grid-cols-[1.5fr_1fr] lg:gap-16">
          <div className="flex flex-col gap-10">
            {template.description === null ? null : (
              <p className="leading-relaxed text-ink-secondary">{template.description}</p>
            )}

            <div>
              <Eyebrow accent>What it covers</Eyebrow>
              <ol className="mt-5 flex flex-col divide-y divide-line border-y border-line">
                {template.sections
                  .filter((section) => section._count.questions > 0)
                  .map((section, index) => (
                    <li key={section.id} className="flex gap-5 py-5">
                      <span className="font-mono text-[0.6875rem] tracking-[0.2em] text-ink-muted">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <div className="flex-1">
                        <p className="font-medium text-ink">{section.title}</p>
                        {section.description === null ? null : (
                          <p className="mt-1 text-sm text-ink-muted">{section.description}</p>
                        )}
                      </div>
                      <span className="font-mono text-[0.6875rem] text-ink-muted">
                        {section._count.questions}
                      </span>
                    </li>
                  ))}
              </ol>
            </div>

            <Panel tone="flat" pad="lg">
              <div className="flex items-start gap-3">
                <Clock className="mt-0.5 size-4 shrink-0 text-xenon" aria-hidden />
                <div>
                  <p className="font-medium text-ink">Your progress is saved as you type</p>
                  <p className="mt-1.5 text-sm leading-relaxed text-ink-secondary">
                    Every answer is stored on the server the moment you stop typing. Close the tab,
                    reload, come back tomorrow - it will be exactly where you left it.
                  </p>
                </div>
              </div>
            </Panel>
          </div>

          <aside className="flex flex-col gap-5 lg:sticky lg:top-28 lg:self-start">
            <Panel tone="raised" pad="lg" edgeLight>
              <Eyebrow>Before you start</Eyebrow>

              {eligibility.requirements.length === 0 ? (
                <p className="mt-3 text-sm text-ink-secondary">
                  There are no requirements for this application.
                </p>
              ) : (
                <ul className="mt-4 flex flex-col gap-3">
                  {eligibility.requirements.map((requirement) => (
                    <li key={requirement.key} className="flex items-start gap-2.5 text-sm">
                      {requirement.met ? (
                        <Check className="mt-0.5 size-4 shrink-0 text-xenon" aria-hidden />
                      ) : (
                        <X className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                      )}
                      <span className={requirement.met ? 'text-ink-secondary' : 'text-ink'}>
                        {requirement.label}
                        {!requirement.met && requirement.href !== null ? (
                          <>
                            {' '}
                            <Link
                              href={requirement.href}
                              className="text-xenon underline underline-offset-2"
                            >
                              {requirement.action ?? 'Fix this'}
                            </Link>
                          </>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <dl className="mt-6 flex flex-col gap-3 border-t border-line pt-5 text-xs">
                <div className="flex items-center justify-between gap-4">
                  <dt className="x-eyebrow">Questions</dt>
                  <dd className="x-tabular text-ink-secondary">{questionCount}</dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="x-eyebrow">Retry after rejection</dt>
                  <dd className="x-tabular text-ink-secondary">
                    {template.rejectionCooldownDays === 0
                      ? 'No cooldown'
                      : `${String(template.rejectionCooldownDays)} days`}
                  </dd>
                </div>
                {template.expiryDays > 0 ? (
                  <div className="flex items-center justify-between gap-4">
                    <dt className="x-eyebrow">Draft expires after</dt>
                    <dd className="x-tabular text-ink-secondary">
                      {String(template.expiryDays)} days
                    </dd>
                  </div>
                ) : null}
              </dl>

              <div className="mt-7">
                {actor.userId === null ? (
                  <Button variant="accent" asChild className="w-full">
                    <Link href={`/signin?callbackUrl=/applications/${template.slug}`}>
                      Sign in with Discord
                    </Link>
                  </Button>
                ) : existing !== null ? (
                  <Button variant="accent" asChild className="w-full">
                    <Link href={`/portal/applications/${existing.publicId}`}>
                      <FileText /> Continue your application
                    </Link>
                  </Button>
                ) : !openState.open ? (
                  <Button variant="outline" disabled className="w-full">
                    <Lock /> {openState.reason ?? 'Closed'}
                  </Button>
                ) : (
                  <StartApplicationButton
                    slug={template.slug}
                    disabled={!eligibility.eligible}
                    availableAt={eligibility.availableAt?.toISOString() ?? null}
                  />
                )}
              </div>
            </Panel>

            {template.department === null ? null : (
              <Button variant="ghost" asChild className="w-full">
                <Link href={`/departments/${template.department.slug}`}>
                  About {template.department.name}
                </Link>
              </Button>
            )}
          </aside>
        </div>
      </Section>
    </>
  );
}
