'use client';

import { Check, Copy, Gamepad2, Link2Off, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Badge, Button, ConfirmDialog, Panel, useToast } from '@xenon/ui';
import { ProgressBar, StepProgress } from '@xenon/ui/motion';

import { issueLinkCodeAction, unlinkIdentityAction } from '~/app/(portal)/portal/actions';

/**
 * FiveM account linking.
 *
 * The code is shown exactly once, here, immediately after it is generated -
 * only its hash is stored, so there is no way to show it again and no way for
 * anyone with database access to read it. If the player loses it they generate
 * a new one, which revokes the old.
 *
 * A live countdown rather than a static expiry time: ten minutes is short, and
 * "expires at 14:32" requires the player to know what time it is now.
 */

export interface LinkedIdentity {
  readonly id: string;
  readonly kind: string;
  readonly value: string;
  readonly label: string | null;
  readonly linkedAt: string;
  readonly isPrimary: boolean;
}

const kindLabel: Record<string, string> = {
  LICENSE: 'Rockstar licence',
  LICENSE2: 'Rockstar licence (2)',
  STEAM: 'Steam',
  DISCORD: 'Discord (in game)',
  FIVEM: 'FiveM',
  XBL: 'Xbox Live',
  LIVE: 'Microsoft',
};

export function FivemLinkPanel({
  identities,
  activeCodeHint,
  activeCodeExpiresAt,
}: {
  identities: readonly LinkedIdentity[];
  activeCodeHint: string | null;
  activeCodeExpiresAt: string | null;
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();

  const [code, setCode] = React.useState<string | null>(null);
  const [expiresAt, setExpiresAt] = React.useState<Date | null>(
    activeCodeExpiresAt === null ? null : new Date(activeCodeExpiresAt),
  );
  const [remaining, setRemaining] = React.useState<number | null>(null);
  /*
   * The full length of the window this code was issued for.
   *
   * Measured from the server's own `expiresAt` at the moment it arrives rather
   * than hardcoded to ten minutes here. A copy of the server's TTL in this file
   * would keep working and start lying the day someone changes it, and a
   * countdown bar that is wrong about its own scale is worse than no bar.
   */
  const [codeWindow, setCodeWindow] = React.useState<number | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [unlinking, setUnlinking] = React.useState<LinkedIdentity | null>(null);
  const [pending, startTransition] = React.useTransition();

  // Countdown ticks in an interval, which is an external system the effect is
  // legitimately synchronising with.
  React.useEffect(() => {
    if (expiresAt === null) return;

    const tick = (): void => {
      const left = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) setCode(null);
    };

    tick();
    const timer = setInterval(tick, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [expiresAt]);

  const generate = (): void => {
    startTransition(async () => {
      const result = await issueLinkCodeAction();
      if (result.ok) {
        const expiry = new Date(result.data.expiresAt);
        setCode(result.data.code);
        setExpiresAt(expiry);
        setCodeWindow(Math.max(1, Math.round((expiry.getTime() - Date.now()) / 1000)));
        setCopied(false);
        return;
      }
      toast.error('Could not generate a code', result.message);
    });
  };

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

  const minutes = remaining === null ? 0 : Math.floor(remaining / 60);
  const seconds = remaining === null ? 0 : remaining % 60;
  const linked = identities.length > 0;

  return (
    <>
      <div className="flex flex-col gap-4">
        {/*
          Three identities becoming one.

          Discord signed you in, Xenon holds the account, and FiveM is the one
          still to be joined - so the rail fills to the node the player is
          actually standing on. It is the clearest thing on the page about what
          linking is *for*, which matters because "type /link ABC-123 in game"
          is otherwise a chore with no visible purpose.

          Every node is a fact: Discord because the session exists, Xenon
          because the account does, FiveM only once an identifier has genuinely
          been attached. Nothing here lights up in anticipation.
        */}
        <StepProgress
          steps={[
            { key: 'discord', label: 'Discord', state: 'complete' },
            { key: 'xenon', label: 'Xenon', state: 'complete' },
            {
              key: 'fivem',
              label: 'FiveM',
              state: linked ? 'complete' : 'active',
              hint: linked ? 'Identity linked' : 'Waiting for a code in game',
            },
          ]}
          className="mx-auto w-full max-w-sm"
          label="Identity linking"
        />

        <Panel tone="raised" pad="lg" edgeLight className="flex flex-col gap-5">
          <div className="flex items-start gap-3">
            <Gamepad2 className="mt-0.5 size-5 shrink-0 text-xenon" aria-hidden />
            <div>
              <p className="font-medium text-ink">Link your game account</p>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-secondary">
                Generate a code here, connect to the city, and type{' '}
                <code className="font-mono text-xenon">/link YOUR-CODE</code> in game. The code
                works once and expires in ten minutes.
              </p>
            </div>
          </div>

          {code !== null ? (
            <div className="flex flex-col gap-3 rounded-lg border border-xenon/30 bg-xenon-deep/15 p-5">
              <p className="x-eyebrow text-xenon">Your code — shown once</p>
              <div className="flex flex-wrap items-center gap-4">
                <code className="font-display text-3xl font-black tracking-[0.15em] text-ink">
                  {code}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    navigator.clipboard
                      .writeText(code)
                      .then(() => {
                        setCopied(true);
                        setTimeout(() => {
                          setCopied(false);
                        }, 2000);
                      })
                      .catch(() => {
                        toast.error('Could not copy', 'Type the code in manually.');
                      });
                  }}
                >
                  {copied ? (
                    <>
                      <Check /> Copied
                    </>
                  ) : (
                    <>
                      <Copy /> Copy
                    </>
                  )}
                </Button>
              </div>
              {/*
                A measured countdown, because this one genuinely is measured:
                the code expires at a known instant and the bar is the fraction
                of ten minutes left. It drains toward empty rather than filling,
                so the shape itself says "running out".
              */}
              {codeWindow === null ? null : (
                <ProgressBar
                  value={remaining ?? 0}
                  max={codeWindow}
                  size="thin"
                  tone={remaining !== null && remaining < 60 ? 'warning' : 'accent'}
                  label="Time left on this code"
                />
              )}
              <p className="x-tabular font-mono text-xs text-ink-muted">
                {remaining === 0
                  ? 'Expired. Generate a new one.'
                  : `Expires in ${String(minutes)}:${String(seconds).padStart(2, '0')}`}
              </p>
            </div>
          ) : activeCodeHint !== null && remaining !== null && remaining > 0 ? (
            <div className="rounded-md border border-line-strong bg-black p-4">
              <p className="text-sm text-ink-secondary">
                You already have a code ending in{' '}
                <code className="font-mono text-ink">{activeCodeHint}</code>. Generating a new one
                cancels it.
              </p>
            </div>
          ) : null}

          <Button variant="accent" loading={pending} onClick={generate} className="self-start">
            <RefreshCw /> {code === null ? 'Generate a link code' : 'Generate a new code'}
          </Button>
        </Panel>

        {identities.length === 0 ? (
          <p className="text-sm text-ink-muted">No game identifiers are linked yet.</p>
        ) : (
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
                    {identity.isPrimary ? <Badge tone="success">Primary</Badge> : null}
                  </div>
                  <code className="truncate font-mono text-xs text-ink-muted">
                    {/* Truncated: the full identifier is a stable account key and
                        does not need to be on screen in full. */}
                    {identity.value.length > 24
                      ? `${identity.value.slice(0, 20)}…`
                      : identity.value}
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
        )}
      </div>

      <ConfirmDialog
        open={unlinking !== null}
        onOpenChange={(open) => {
          if (!open) setUnlinking(null);
        }}
        title="Unlink this identifier?"
        description="You will not be able to connect with this account until you link it again. Your whitelist and characters are not affected."
        confirmLabel="Unlink"
        tone="danger"
        loading={pending}
        onConfirm={unlink}
      />
    </>
  );
}
