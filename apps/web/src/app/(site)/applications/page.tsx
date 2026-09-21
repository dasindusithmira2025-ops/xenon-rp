import { ArrowRight, Check, Lock, X } from 'lucide-react';
import Link from 'next/link';

import { publicTemplates } from '@xenon/applications';
import { prisma } from '@xenon/database';
import { Badge, Button, EmptyState, Panel } from '@xenon/ui';
import { Reveal } from '@xenon/ui/motion';

import type { Metadata } from 'next';

import { PageHeader, Section } from '~/components/site/section';
import { currentActor } from '~/server/context';

export const metadata: Metadata = {
  title: 'Applications',
  description:
    'Apply to XenonRP. Whitelist, departments and community roles - every application is read by a person.',
  alternates: { canonical: '/applications' },
};

/**
 * /applications
 *
 * Per-visitor, because eligibility is per-visitor: a signed-in player sees
 * exactly which requirements they have already met and which they have not,
 * rather than a disabled button with no explanation.
 *
 * Only templates staff have published are listed. Draft and archived intakes
 * are excluded at the query rather than hidden in the markup.
 */
export const dynamic = 'force-dynamic';

export default async function ApplicationsPage(): Promise<React.ReactElement> {
  const actor = await currentActor();
  const templates = await publicTemplates(prisma, actor);

  const open = templates.filter((template) => template.open);
  const closed = templates.filter((template) => !template.open);

  return (
    <>
      <PageHeader
        eyebrow="Applications"
        title={
          <>
            Write your
            <br />
            way in
          </>
        }
        lead="Xenon is whitelisted because the standard is the point. Set aside real time - your progress saves as you type, and you can come back to it."
      >
        {actor.userId === null ? (
          <div className="mt-8">
            <Button variant="accent" size="lg" asChild>
              <Link href="/signin?callbackUrl=/applications">
                Sign in to apply <ArrowRight />
              </Link>
            </Button>
          </div>
        ) : null}
      </PageHeader>

      <Section width="wide">
        {templates.length === 0 ? (
          <EmptyState
            title="No applications are published yet"
            description="Application types are built and opened from the Xenon control centre. When one opens it appears here."
            action={
              <Button variant="outline" asChild>
                <Link href="/support">Ask a question</Link>
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col gap-12">
            {open.length > 0 ? (
              <div className="grid gap-5 lg:grid-cols-2">
                {open.map((template, index) => (
                  <Reveal key={template.slug} delay={(index % 2) * 0.06}>
                    <Panel
                      tone="raised"
                      pad="none"
                      edgeLight
                      className="flex h-full flex-col overflow-hidden"
                    >
                      <div className="flex flex-1 flex-col gap-5 p-7 lg:p-9">
                        <div className="flex flex-wrap items-center gap-2.5">
                          <Badge tone="success">Open</Badge>
                          {template.departmentName === null ? null : (
                            <Badge tone="chrome">{template.departmentName}</Badge>
                          )}
                          {template.grantsWhitelist ? (
                            <Badge tone="info">Grants whitelist</Badge>
                          ) : null}
                          {template.interviewRequired ? (
                            <Badge tone="warning">Interview</Badge>
                          ) : null}
                        </div>

                        <div className="flex flex-col gap-2.5">
                          <h2 className="font-display text-title font-black text-ink uppercase">
                            {template.name}
                          </h2>
                          {template.summary === null ? null : (
                            <p className="text-lead text-ink-secondary">{template.summary}</p>
                          )}
                        </div>

                        {template.description === null ? null : (
                          <p className="text-sm leading-relaxed text-ink-muted">
                            {template.description}
                          </p>
                        )}

                        <dl className="mt-auto grid grid-cols-2 gap-x-6 gap-y-3 border-t border-line pt-5 text-xs">
                          <div className="flex flex-col gap-0.5">
                            <dt className="x-eyebrow">Questions</dt>
                            <dd className="x-tabular text-ink-secondary">
                              {template.questionCount}
                            </dd>
                          </div>
                          <div className="flex flex-col gap-0.5">
                            <dt className="x-eyebrow">Retry after</dt>
                            <dd className="x-tabular text-ink-secondary">
                              {template.rejectionCooldownDays === 0
                                ? 'No cooldown'
                                : `${String(template.rejectionCooldownDays)} days`}
                            </dd>
                          </div>
                        </dl>

                        {/* Requirements are only meaningful for a signed-in
                            visitor; for anyone else the honest answer is "sign
                            in and we will tell you". */}
                        {actor.userId !== null && template.unmetRequirements.length > 0 ? (
                          <ul className="flex flex-col gap-2 rounded-md border border-warning/25 bg-warning/5 p-4">
                            {template.unmetRequirements.map((requirement) => (
                              <li
                                key={requirement.label}
                                className="flex items-start gap-2.5 text-xs text-warning"
                              >
                                <X className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                                <span className="flex-1">{requirement.label}</span>
                                {requirement.href === null ? null : (
                                  <Link
                                    href={requirement.href}
                                    className="shrink-0 underline underline-offset-2"
                                  >
                                    {requirement.action ?? 'Fix'}
                                  </Link>
                                )}
                              </li>
                            ))}
                          </ul>
                        ) : null}

                        {actor.userId !== null && template.eligible === true ? (
                          <p className="inline-flex items-center gap-2 text-xs text-xenon">
                            <Check className="size-3.5" aria-hidden /> You meet every requirement
                          </p>
                        ) : null}
                      </div>

                      <div className="border-t border-line p-7 pt-5 lg:px-9">
                        {actor.userId === null ? (
                          <Button variant="outline" asChild className="w-full">
                            <Link href={`/signin?callbackUrl=/applications/${template.slug}`}>
                              Sign in to apply
                            </Link>
                          </Button>
                        ) : (
                          <Button
                            variant={template.eligible === true ? 'accent' : 'outline'}
                            asChild
                            className="w-full"
                          >
                            <Link href={`/applications/${template.slug}`}>
                              {template.eligible === true ? 'Start application' : 'View details'}
                            </Link>
                          </Button>
                        )}
                      </div>
                    </Panel>
                  </Reveal>
                ))}
              </div>
            ) : null}

            {closed.length > 0 ? (
              <div className="flex flex-col gap-4">
                <p className="x-eyebrow">Not accepting right now</p>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {closed.map((template) => (
                    <Panel key={template.slug} tone="flat" pad="lg" className="opacity-70">
                      <div className="flex items-start justify-between gap-3">
                        <h3 className="font-display text-base font-bold text-ink-secondary">
                          {template.name}
                        </h3>
                        <Lock className="size-4 shrink-0 text-ink-muted" aria-hidden />
                      </div>
                      <p className="mt-2 text-xs text-ink-muted">
                        {template.closedReason ?? 'Closed.'}
                      </p>
                    </Panel>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </Section>

      <Section tone="black" size="sm">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-display text-lg font-bold text-ink">Read the rules first</p>
            <p className="mt-1 text-sm text-ink-muted">
              Most applications ask about them, and accepting the current ruleset is a requirement.
            </p>
          </div>
          <Button variant="outline" asChild className="shrink-0">
            <Link href="/rules">Open the rulebook</Link>
          </Button>
        </div>
      </Section>
    </>
  );
}
