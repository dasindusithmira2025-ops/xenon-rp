'use client';

import { Check, Circle } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import type { OnboardingState } from '@xenon/domain';
import { Button, Panel, useToast } from '@xenon/ui';
import {
  AnimatedCounter,
  type JourneyStep,
  ProgressBar,
  Spinner,
  StepProgress,
} from '@xenon/ui/motion';

import { acceptRulesAction } from '~/app/(portal)/portal/actions';

/**
 * Onboarding checklist.
 *
 * Derived from facts rather than from a stored cursor, which is why a player
 * who links FiveM in game - never touching this page - sees the step already
 * ticked when they come back.
 *
 * The rules step accepts inline because it is the only step whose action
 * belongs to this page. Everything else links to where it actually happens.
 */

export interface OnboardingProps {
  readonly state: OnboardingState;
  readonly discordInvite: string | null;
  readonly ruleVersion: number | null;
}

interface Step {
  readonly key: string;
  readonly title: string;
  /** Two words at most: this is the label under a node on the journey rail. */
  readonly short: string;
  readonly body: string;
  readonly met: boolean;
  readonly action: React.ReactNode;
}

export function Onboarding({
  state,
  discordInvite,
  ruleVersion,
}: OnboardingProps): React.ReactElement | null {
  const router = useRouter();
  const toast = useToast();
  const [accepting, startAccepting] = React.useTransition();

  const acceptRules = (): void => {
    startAccepting(async () => {
      const result = await acceptRulesAction();
      if (result.ok) {
        toast.success('Rules accepted', `You accepted version ${String(result.data.version)}.`);
        router.refresh();
        return;
      }
      toast.error('Could not record that', result.message);
    });
  };

  const steps: Step[] = [
    {
      key: 'discord',
      short: 'Discord',
      title: 'Discord connected',
      body: 'Your Discord account is your Xenon identity.',
      met: state.checks.discordLinked,
      action: null,
    },
    {
      key: 'guild',
      short: 'Server',
      title: 'Join the Discord',
      body: 'Most applications require membership, and it is where staff reach you.',
      met: state.checks.guildMember,
      action:
        discordInvite === null ? (
          <span className="text-xs text-ink-muted">No invite configured</span>
        ) : (
          <Button variant="outline" size="sm" asChild>
            <a href={discordInvite} target="_blank" rel="noopener noreferrer">
              Open Discord
            </a>
          </Button>
        ),
    },
    {
      key: 'profile',
      short: 'Profile',
      title: 'Set a display name',
      body: 'How staff and other players see you on the site.',
      met: state.checks.profileComplete,
      action: (
        <Button variant="outline" size="sm" asChild>
          <Link href="/portal/account">Edit profile</Link>
        </Button>
      ),
    },
    {
      key: 'rules',
      short: 'Rules',
      title:
        ruleVersion === null ? 'Accept the rules' : `Accept the rules (v${String(ruleVersion)})`,
      body: 'Read the rulebook and confirm you accept the current version.',
      met: state.checks.rulesAccepted,
      action: state.checks.rulesAccepted ? null : (
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/rules">Read</Link>
          </Button>
          <Button
            variant="accent"
            size="sm"
            loading={accepting}
            disabled={ruleVersion === null}
            onClick={acceptRules}
          >
            Accept
          </Button>
        </div>
      ),
    },
    {
      key: 'fivem',
      short: 'FiveM',
      title: 'Link your FiveM account',
      body: 'Generate a code here and type it in game. This is how the server knows you.',
      met: state.checks.fivemLinked,
      action: (
        <Button variant="outline" size="sm" asChild>
          <Link href="/portal/account#fivem">Get a code</Link>
        </Button>
      ),
    },
    {
      key: 'whitelist',
      short: 'Whitelist',
      title: 'Get whitelisted',
      body: 'Apply, and a member of staff will read it properly.',
      met: state.checks.whitelisted,
      action: (
        <Button variant="accent" size="sm" asChild>
          <Link href="/applications">Apply</Link>
        </Button>
      ),
    },
  ];

  const done = steps.filter((step) => step.met).length;
  // Nothing to nag about once everything is done; the panel simply disappears.
  if (done === steps.length) return null;

  /*
   * The same six steps, told twice.
   *
   * The journey rail is the shape of the thing - where you are, what is behind
   * you, what is still ahead - and the list below it is the detail. Neither
   * invents a state: every node comes from `state.checks`, which is derived
   * from facts rather than from a stored cursor, so a player who linked FiveM
   * in game without ever opening this page finds that node already lit.
   */
  const journey: JourneyStep[] = steps.map((step, index) => ({
    key: step.key,
    label: step.short,
    state: step.met
      ? 'complete'
      : steps.slice(0, index).every((earlier) => earlier.met)
        ? 'active'
        : 'pending',
  }));

  return (
    <Panel tone="raised" pad="none" edgeLight className="overflow-hidden">
      <div className="flex flex-col gap-5 border-b border-line p-6">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="font-display text-lg font-bold text-ink">Getting into the city</h2>
          <span className="x-tabular font-mono text-xs text-ink-muted">
            <AnimatedCounter value={done} countOnReveal={false} className="text-ink" /> of{' '}
            {steps.length}
          </span>
        </div>

        <ProgressBar value={done} max={steps.length} label="Onboarding progress" />

        {/* Hidden on the narrowest screens: six labelled nodes across 375px is
            six unreadable labels, and the list underneath already says it. */}
        <StepProgress steps={journey} className="hidden pt-2 sm:flex" label="Onboarding journey" />
      </div>

      <ol className="flex flex-col divide-y divide-line">
        {steps.map((step, index) => {
          // The first unmet step is the one being asked for; later unmet steps
          // are dimmed so the list reads as a path rather than a pile of tasks.
          const isNext = !step.met && steps.slice(0, index).every((earlier) => earlier.met);

          return (
            <li
              key={step.key}
              className={
                step.met
                  ? 'flex items-start gap-4 p-5 opacity-60'
                  : isNext
                    ? 'flex items-start gap-4 bg-xenon-deep/10 p-5'
                    : 'flex items-start gap-4 p-5 opacity-50'
              }
            >
              <span className="mt-0.5 shrink-0">
                {step.met ? (
                  <Check className="size-4 text-xenon" aria-label="Complete" />
                ) : accepting && step.key === 'rules' ? (
                  <Spinner className="size-4 text-ink-muted" label="Recording" />
                ) : (
                  <Circle className="size-4 text-ink-muted" aria-label="Not done" />
                )}
              </span>

              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="text-sm font-medium text-ink">{step.title}</p>
                <p className="text-xs leading-relaxed text-ink-muted">{step.body}</p>
              </div>

              {step.met ? null : <div className="shrink-0">{step.action}</div>}
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
