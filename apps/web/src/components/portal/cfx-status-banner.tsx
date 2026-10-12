import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

import type { OnboardingState } from '@xenon/domain';
import { cn } from '@xenon/ui';

import type { CfxStatus } from '~/server/cfx';

/**
 * The outcome of a Cfx.re round trip, said at the top of the account page.
 *
 * Every `/api/v1/me/cfx/*` route redirects back with a fixed `?cfx=` key; the
 * copy for each key lives here and nowhere else. Anything not in the table is
 * ignored rather than echoed, so a crafted query string cannot put words on the
 * page.
 */

type Tone = 'success' | 'neutral' | 'attention' | 'danger';

const copy: Record<CfxStatus, { tone: Tone; title: string; body: string }> = {
  linked: {
    tone: 'success',
    title: 'Cfx.re account connected',
    body: 'Your verified Cfx.re account is now linked to Xenon. Linking proves who you are; it does not whitelist you.',
  },
  unlinked: {
    tone: 'neutral',
    title: 'Cfx.re account unlinked',
    body: 'You cannot join the city until you connect a Cfx.re account again.',
  },
  cancelled: {
    tone: 'neutral',
    title: 'Connection cancelled',
    body: 'Nothing was linked. You can start again whenever you are ready.',
  },
  expired: {
    tone: 'attention',
    title: 'That attempt expired',
    body: 'Approval on Cfx.re took too long. Start again and approve Xenon on forum.cfx.re.',
  },
  invalid: {
    tone: 'danger',
    title: 'Cfx.re sent back something we could not verify',
    body: 'Nothing was linked. Start again from this page.',
  },
  mismatch: {
    tone: 'attention',
    title: 'Started somewhere else',
    body: 'That approval belongs to a connection started in another browser or by a different Xenon account. Start again here, in this browser.',
  },
  conflict: {
    tone: 'danger',
    title: 'Cfx.re account already in use',
    body: 'That Cfx.re account is already linked to another Xenon account - open a support ticket if it is yours.',
  },
  'already-linked': {
    tone: 'attention',
    title: 'You already have a Cfx.re account linked',
    body: 'Unlink it under Manage first if you want to connect a different one.',
  },
  provider: {
    tone: 'danger',
    title: 'Cfx.re could not be reached',
    body: 'Nothing was linked. Try again in a moment.',
  },
  'insecure-callback': {
    tone: 'danger',
    title: 'Cfx.re linking is unavailable here',
    body: 'forum.cfx.re only returns to https sites. Use the live Xenon website, or an https staging address.',
  },
  'rate-limited': {
    tone: 'attention',
    title: 'Too many attempts',
    body: 'Wait a few minutes before trying again.',
  },
  'unlink-confirm': {
    tone: 'attention',
    title: 'Not unlinked',
    body: 'Type the confirmation word exactly as shown to unlink your Cfx.re account.',
  },
  'not-linked': {
    tone: 'neutral',
    title: 'Nothing to unlink',
    body: 'There is no Cfx.re account linked to this Xenon account.',
  },
  signin: {
    tone: 'attention',
    title: 'Sign in again',
    body: 'Your session ended before Cfx.re sent you back. Sign in and start again.',
  },
  error: {
    tone: 'danger',
    title: 'Something went wrong',
    body: 'Nothing was changed. Try again, and open a support ticket if it keeps happening.',
  },
};

type OnboardingStep = OnboardingState['step'];

const nextStepCopy: Partial<Record<OnboardingStep, string>> = {
  DISCORD_CONNECTED: 'Next: connect your Discord account.',
  GUILD_MEMBERSHIP: 'Next: join the Xenon Discord server.',
  PROFILE: 'Next: set a display name below.',
  RULES: 'Next: accept the server rules.',
  WHITELIST: 'Next: apply for the whitelist.',
};

const panel: Record<Tone, string> = {
  success: 'border-xenon/30 bg-xenon-deep/15',
  neutral: 'border-line-strong bg-surface',
  attention: 'border-warning/30 bg-warning/5',
  danger: 'border-danger/30 bg-danger/5',
};

const label: Record<Tone, string> = {
  success: 'text-xenon',
  neutral: 'text-ink-muted',
  attention: 'text-warning',
  danger: 'text-danger',
};

/** The status key from the query string, or null when absent or unknown. */
export function parseCfxStatus(value: string | string[] | undefined): CfxStatus | null {
  const key = Array.isArray(value) ? value[0] : value;
  return key !== undefined && Object.hasOwn(copy, key) ? (key as CfxStatus) : null;
}

export function CfxStatusBanner({
  status,
  next,
}: {
  status: CfxStatus;
  /** The player's next onboarding step, mentioned after a successful link. */
  next: OnboardingStep | null;
}): React.ReactElement {
  const { tone, title, body } = copy[status];
  const nextStep = status === 'linked' && next !== null ? nextStepCopy[next] : undefined;

  return (
    <section
      role={tone === 'danger' ? 'alert' : 'status'}
      aria-label="Cfx.re connection"
      className={cn('flex flex-col gap-2 rounded-lg border p-5', panel[tone])}
    >
      <p className={cn('x-eyebrow', label[tone])}>{title}</p>
      <p className="max-w-2xl text-sm leading-relaxed text-ink-secondary">{body}</p>
      {nextStep === undefined ? null : (
        <Link
          href="/portal"
          className="inline-flex items-center gap-2 self-start py-1 font-mono text-[0.6875rem] tracking-[0.16em] text-ink uppercase transition-colors duration-(--duration-fast) hover:text-xenon"
        >
          {nextStep} <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      )}
    </section>
  );
}
