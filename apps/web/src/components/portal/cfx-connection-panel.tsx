'use client';

import { Clock, ExternalLink, Gamepad2, Link2Off, ShieldCheck, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Badge, Button, type ButtonProps, ConfirmDialog, Input, Panel, useToast } from '@xenon/ui';
import { ProgressBar, StepProgress } from '@xenon/ui/motion';

import { unlinkIdentityAction } from '~/app/(portal)/portal/actions';

/**
 * The player's Cfx.re connection.
 *
 * Every mutation here is a plain HTML form posted to `/api/v1/me/cfx/*`, not a
 * server action: "Connect" has to leave the site for forum.cfx.re, and each
 * route answers with a 303 back to the account page carrying a status key the
 * page turns into a banner. A full navigation also means the page - and the
 * onboarding checklist on it - is rendered fresh from the database afterwards.
 *
 * The one server action left is the legacy identifier unlink: rows written by
 * the retired in-game code flow are shown read-only so the player can clear
 * them, but nothing new is ever created that way.
 */

export const CFX_ROUTES = {
  authorize: '/api/v1/me/cfx/authorize',
  cancel: '/api/v1/me/cfx/cancel',
  unlink: '/api/v1/me/cfx/unlink',
} as const;

export interface LegacyIdentity {
  readonly id: string;
  readonly kind: string;
  readonly value: string;
  readonly linkedAt: string;
  readonly isPrimary: boolean;
}

export interface CfxConnectionView {
  readonly linked: boolean;
  readonly username: string | null;
  readonly cfxUserId: string | null;
  readonly linkedAt: string | null;
}

const kindLabel: Record<string, string> = {
  LICENSE: 'Rockstar licence',
  LICENSE2: 'Rockstar licence (2)',
  STEAM: 'Steam',
  DISCORD: 'Discord (in game)',
  FIVEM: 'Cfx.re',
  XBL: 'Xbox Live',
  LIVE: 'Microsoft',
};

/**
 * A same-origin POST form that shows its own pending state.
 *
 * `useFormStatus` only reports forms whose action is a function, and these post
 * to a URL, so the form tracks its own submission. Going back to the page from
 * the browser's history restores it from the back-forward cache with the
 * spinner still showing, which `pageshow` undoes.
 */
export function CfxPostForm({
  action,
  className,
  children,
}: {
  action: string;
  className?: string;
  children: (submitting: boolean) => React.ReactNode;
}): React.ReactElement {
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    const restore = (event: PageTransitionEvent): void => {
      if (event.persisted) setSubmitting(false);
    };
    window.addEventListener('pageshow', restore);
    return () => {
      window.removeEventListener('pageshow', restore);
    };
  }, []);

  return (
    <form
      method="post"
      action={action}
      className={className}
      onSubmit={() => {
        setSubmitting(true);
      }}
    >
      {children(submitting)}
    </form>
  );
}

/** "Connect Cfx.re": starts an attempt and sends the browser to forum.cfx.re. */
export function ConnectCfxForm({
  label = 'Connect Cfx.re',
  variant = 'accent',
  size,
  className,
}: {
  label?: string;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  className?: string;
}): React.ReactElement {
  return (
    <CfxPostForm action={CFX_ROUTES.authorize} className={className}>
      {(submitting) => (
        <Button type="submit" variant={variant} size={size} loading={submitting}>
          <ExternalLink /> {label}
        </Button>
      )}
    </CfxPostForm>
  );
}

export function CfxConnectionPanel({
  connection,
  pendingExpiresAt,
  attemptWindowSeconds,
  legacyIdentities,
  unlinkPhrase,
}: {
  connection: CfxConnectionView;
  /** Expiry of an outstanding attempt, or null when none is live. */
  pendingExpiresAt: string | null;
  /** The full length of an attempt, so the countdown bar has a true scale. */
  attemptWindowSeconds: number;
  /** Active identities that are not the verified Cfx.re account. */
  legacyIdentities: readonly LegacyIdentity[];
  unlinkPhrase: string;
}): React.ReactElement {
  const pending = !connection.linked && pendingExpiresAt !== null;

  return (
    <div className="flex flex-col gap-4">
      {/*
        Three identities becoming one. Every node is a fact: Discord because the
        session exists, Xenon because the account does, Cfx.re only once a
        verified account is attached. Nothing lights up in anticipation.
      */}
      <StepProgress
        steps={[
          { key: 'discord', label: 'Discord', state: 'complete' },
          { key: 'xenon', label: 'Xenon', state: 'complete' },
          {
            key: 'cfx',
            label: 'Cfx.re',
            state: connection.linked ? 'complete' : 'active',
            hint: connection.linked
              ? 'Account verified'
              : pending
                ? 'Waiting for approval'
                : 'Not connected',
          },
        ]}
        className="mx-auto w-full max-w-sm"
        label="Identity linking"
      />

      {connection.linked ? (
        <LinkedState connection={connection} unlinkPhrase={unlinkPhrase} />
      ) : pending ? (
        <PendingState expiresAt={pendingExpiresAt} windowSeconds={attemptWindowSeconds} />
      ) : (
        <NotLinkedState legacy={legacyIdentities.length > 0} />
      )}

      {legacyIdentities.length === 0 ? null : (
        <LegacyIdentities identities={legacyIdentities} linked={connection.linked} />
      )}
    </div>
  );
}

function PrivacyNote(): React.ReactElement {
  return (
    <p className="text-xs leading-relaxed text-ink-muted">
      Xenon only learns your Cfx.re account id and username. The authorization key Cfx.re issues is
      discarded the moment it is read, and nothing is ever posted on your behalf.
    </p>
  );
}

function NotLinkedState({ legacy }: { legacy: boolean }): React.ReactElement {
  return (
    <Panel tone="raised" pad="lg" edgeLight className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <Gamepad2 className="mt-0.5 size-5 shrink-0 text-xenon" aria-hidden />
        <div>
          <p className="font-medium text-ink">Connect your Cfx.re account</p>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-secondary">
            {legacy
              ? 'Your account still has identifiers from the old in-game code flow, which no longer admit you to the city. Connect your Cfx.re account to replace them.'
              : 'The city recognises you by your verified Cfx.re account. You will be sent to forum.cfx.re to approve Xenon, then straight back here.'}
          </p>
        </div>
      </div>

      <PrivacyNote />

      <ConnectCfxForm className="self-start" />
    </Panel>
  );
}

function PendingState({
  expiresAt,
  windowSeconds,
}: {
  expiresAt: string;
  windowSeconds: number;
}): React.ReactElement {
  const [remaining, setRemaining] = React.useState<number | null>(null);

  // The countdown ticks in an interval, an external system the effect is
  // legitimately synchronising with. Measured client-side only so the server
  // render and hydration agree.
  React.useEffect(() => {
    const expiry = new Date(expiresAt).getTime();
    const tick = (): void => {
      setRemaining(Math.max(0, Math.floor((expiry - Date.now()) / 1000)));
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [expiresAt]);

  const expired = remaining === 0;
  const minutes = remaining === null ? 0 : Math.floor(remaining / 60);
  const seconds = remaining === null ? 0 : remaining % 60;

  return (
    <Panel tone="raised" pad="lg" edgeLight className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <Clock className="mt-0.5 size-5 shrink-0 text-xenon" aria-hidden />
        <div>
          <p className="font-medium text-ink">
            {expired ? 'That attempt expired' : 'Waiting for Cfx.re approval'}
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-secondary">
            {expired
              ? 'Cfx.re did not send you back in time. Start again to get a fresh approval page.'
              : 'Approve Xenon on forum.cfx.re and you will be brought straight back here. Closed the tab? Open it again.'}
          </p>
        </div>
      </div>

      {remaining === null || expired ? null : (
        <div className="flex flex-col gap-2">
          {/* Drains toward empty, so the shape itself says "running out". */}
          <ProgressBar
            value={remaining}
            max={windowSeconds}
            size="thin"
            tone={remaining < 60 ? 'warning' : 'accent'}
            label="Time left to approve on Cfx.re"
          />
          <p className="x-tabular font-mono text-xs text-ink-muted">
            Expires in {String(minutes)}:{String(seconds).padStart(2, '0')}
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <ConnectCfxForm label={expired ? 'Connect Cfx.re' : 'Open Cfx.re again'} />
        {expired ? null : (
          <CfxPostForm action={CFX_ROUTES.cancel}>
            {(submitting) => (
              <Button type="submit" variant="ghost" loading={submitting}>
                <X /> Cancel
              </Button>
            )}
          </CfxPostForm>
        )}
      </div>

      <PrivacyNote />
    </Panel>
  );
}

function LinkedState({
  connection,
  unlinkPhrase,
}: {
  connection: CfxConnectionView;
  unlinkPhrase: string;
}): React.ReactElement {
  const [managing, setManaging] = React.useState(false);
  const [phrase, setPhrase] = React.useState('');

  return (
    <Panel tone="raised" pad="lg" edgeLight className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-xenon" aria-hidden />
          <div className="min-w-0">
            <p className="font-medium text-ink">
              {connection.username ?? 'Cfx.re account'}
              {connection.cfxUserId === null ? null : (
                <span className="ml-2 font-mono text-xs text-ink-muted">
                  #{connection.cfxUserId}
                </span>
              )}
            </p>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-secondary">
              Verified through forum.cfx.re
              {connection.linkedAt === null
                ? '.'
                : ` on ${new Date(connection.linkedAt).toLocaleDateString('en-GB')}.`}{' '}
              Linking proves who you are; it does not whitelist you.
            </p>
          </div>
        </div>
        <Badge tone="success">Linked</Badge>
      </div>

      <div className="border-t border-line pt-4">
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={managing}
          onClick={() => {
            setManaging((open) => !open);
            setPhrase('');
          }}
        >
          {managing ? 'Close' : 'Manage'}
        </Button>

        {managing ? (
          <CfxPostForm
            action={CFX_ROUTES.unlink}
            className="mt-4 flex flex-col gap-3 rounded-md border border-danger/30 bg-danger/5 p-4"
          >
            {(submitting) => (
              <>
                <p className="text-sm font-medium text-ink">Unlink this Cfx.re account</p>
                <p className="text-xs leading-relaxed text-ink-secondary">
                  You will not be able to join the city until you connect a Cfx.re account again.
                  Your whitelist and characters are not affected.
                </p>
                <label htmlFor="cfx-unlink-confirm" className="text-xs text-ink-muted">
                  Type <code className="font-mono text-ink">{unlinkPhrase}</code> to confirm
                </label>
                <div className="flex flex-wrap items-center gap-3">
                  <Input
                    id="cfx-unlink-confirm"
                    name="confirm"
                    autoComplete="off"
                    spellCheck={false}
                    value={phrase}
                    onChange={(event) => {
                      setPhrase(event.target.value);
                    }}
                    className="max-w-48 font-mono"
                  />
                  <Button
                    type="submit"
                    variant="danger"
                    size="sm"
                    loading={submitting}
                    disabled={phrase !== unlinkPhrase}
                  >
                    <Link2Off /> Unlink
                  </Button>
                </div>
              </>
            )}
          </CfxPostForm>
        ) : null}
      </div>
    </Panel>
  );
}

function LegacyIdentities({
  identities,
  linked,
}: {
  identities: readonly LegacyIdentity[];
  linked: boolean;
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [unlinking, setUnlinking] = React.useState<LegacyIdentity | null>(null);
  const [pending, startTransition] = React.useTransition();

  const unlink = (): void => {
    if (unlinking === null) return;
    startTransition(async () => {
      const result = await unlinkIdentityAction(unlinking.id);
      if (result.ok) {
        toast.success('Identifier unlinked');
        setUnlinking(null);
        router.refresh();
        return;
      }
      toast.error('Could not unlink', result.message);
    });
  };

  return (
    <>
      <div className="flex flex-col gap-2">
        <p className="x-eyebrow">Older game identifiers</p>
        <p className="text-xs leading-relaxed text-ink-muted">
          {linked
            ? 'Recorded by the retired in-game code flow. Your Cfx.re account is what admits you now; these can be removed.'
            : 'Recorded by the retired in-game code flow. They no longer admit you to the city - connect Cfx.re above.'}
        </p>
        <Panel tone="flat" pad="none" className="divide-y divide-line">
          {identities.map((identity) => (
            <div
              key={identity.id}
              className="flex flex-wrap items-center justify-between gap-3 p-4"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-ink">
                    {kindLabel[identity.kind] ?? identity.kind}
                  </span>
                  {identity.isPrimary ? <Badge tone="neutral">Primary</Badge> : null}
                </div>
                <code className="truncate font-mono text-xs text-ink-muted">
                  {/* Truncated: the full identifier is a stable account key and
                      does not need to be on screen in full. */}
                  {identity.value.length > 24 ? `${identity.value.slice(0, 20)}…` : identity.value}
                </code>
              </div>

              <div className="flex items-center gap-3">
                <span className="font-mono text-[0.625rem] tracking-[0.12em] text-ink-muted uppercase">
                  {new Date(identity.linkedAt).toLocaleDateString('en-GB')}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setUnlinking(identity);
                  }}
                >
                  <Link2Off /> Unlink
                </Button>
              </div>
            </div>
          ))}
        </Panel>
      </div>

      <ConfirmDialog
        open={unlinking !== null}
        onOpenChange={(open) => {
          if (!open) setUnlinking(null);
        }}
        title="Remove this identifier?"
        description="It was recorded by the retired in-game code flow and no longer admits you to the city. Your whitelist and characters are not affected."
        confirmLabel="Remove"
        tone="danger"
        loading={pending}
        onConfirm={unlink}
      />
    </>
  );
}
