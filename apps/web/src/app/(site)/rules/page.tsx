import { Check } from 'lucide-react';
import Link from 'next/link';

import { prisma } from '@xenon/database';
import { hasAcceptedCurrentRules, publishedRulebook } from '@xenon/domain';
import { Button, EmptyState, Panel } from '@xenon/ui';
import { ScrollProgress } from '@xenon/ui/motion';

import type { Metadata } from 'next';

import { RulebookBrowser } from '~/components/rules/rulebook-browser';
import { PageHeader, Section } from '~/components/site/section';
import { currentActor } from '~/server/context';

export const metadata: Metadata = {
  title: { absolute: 'XenonRP Rules | Official Server Rulebook' },
  description: 'The official XenonRP server rulebook.',
  alternates: { canonical: '/rules' },
};

export const revalidate = 300;

/**
 * /rules
 *
 * The published XenonRP rulebook is versioned in the database; page rendering
 * reads the published record only.
 */
export default async function RulesPage(): Promise<React.ReactElement> {
  const [rulebook, actor] = await Promise.all([publishedRulebook(prisma), currentActor()]);

  const accepted =
    actor.userId === null ? false : await hasAcceptedCurrentRules(prisma, actor.userId);

  return (
    <>
      <ScrollProgress />

      <PageHeader
        eyebrow="Official rulebook"
        title={
          <>
            Official
            <br />
            rulebook
          </>
        }
        lead="The current XenonRP rules for fair, immersive roleplay. Follow any additional activity and faction rules that apply."
      >
        <div className="mt-8 flex flex-wrap items-center gap-4">
          <span className="rounded-pill border border-line-strong px-3.5 py-1.5 font-mono text-[0.625rem] tracking-[0.16em] text-ink-secondary uppercase">
            {rulebook.version === null ? 'Unpublished' : `Version ${String(rulebook.version)}`}
          </span>
          {rulebook.sourceRetrievedAt === null ? null : (
            <span className="font-mono text-[0.625rem] tracking-[0.16em] text-ink-muted uppercase">
              Last synchronized{' '}
              {new Date(rulebook.sourceRetrievedAt).toLocaleDateString('en-GB', {
                day: '2-digit',
                month: 'short',
                year: 'numeric',
              })}
            </span>
          )}
          {actor.userId !== null && accepted ? (
            <span className="inline-flex items-center gap-1.5 font-mono text-[0.625rem] tracking-[0.16em] text-xenon uppercase">
              <Check className="size-3.5" /> Accepted by you
            </span>
          ) : null}
        </div>
      </PageHeader>

      <Section width="wide">
        {rulebook.categories.length === 0 ? (
          <EmptyState
            title="The rulebook has not been published yet"
            description="The official XenonRP rulebook has not been synchronized into Xenon yet."
            action={
              <Button variant="outline" asChild>
                <Link href="/support">Ask a question</Link>
              </Button>
            }
          />
        ) : (
          <>
            <RulebookBrowser rulebook={rulebook} />

            {actor.userId !== null && !accepted ? (
              <Panel tone="accent" pad="lg" className="mt-16">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-display text-lg font-bold text-ink">
                      You have not accepted version {String(rulebook.version)}
                    </p>
                    <p className="mt-1 text-sm text-ink-secondary">
                      Accepting is part of onboarding and is required before you can apply.
                    </p>
                  </div>
                  <Button variant="accent" asChild className="shrink-0">
                    <Link href="/portal">Accept in your portal</Link>
                  </Button>
                </div>
              </Panel>
            ) : null}
          </>
        )}
      </Section>
    </>
  );
}
