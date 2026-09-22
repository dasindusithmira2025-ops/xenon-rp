'use client';

import { ArrowUpRight, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Badge, Button, useToast } from '@xenon/ui';

import { resyncDiscordMembershipAction } from '~/app/(portal)/portal/actions';

type MembershipState =
  'UNKNOWN' | 'MEMBER' | 'PENDING_SCREENING' | 'NOT_MEMBER' | 'UNAVAILABLE' | 'MISCONFIGURED';

const membershipLabel: Record<MembershipState, string> = {
  UNKNOWN: 'Not checked',
  MEMBER: 'Member',
  PENDING_SCREENING: 'Membership screening pending',
  NOT_MEMBER: 'Not joined',
  UNAVAILABLE: 'Could not verify',
  MISCONFIGURED: 'Discord setup needs attention',
};

export function DiscordMembership({
  state,
  syncedAt,
  error,
  invite,
  enabled,
}: {
  state: MembershipState;
  syncedAt: string | null;
  error: string | null;
  invite: string | null;
  enabled: boolean;
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = React.useState(false);
  const previousSync = React.useRef(syncedAt);

  React.useEffect(() => {
    if (!pending) return;
    const interval = window.setInterval(() => {
      router.refresh();
    }, 2500);
    const timeout = window.setTimeout(() => {
      setPending(false);
      toast.error('Discord is taking longer than expected', 'You can check again in a moment.');
    }, 30_000);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [pending, router, toast]);

  React.useEffect(() => {
    if (!pending || syncedAt === previousSync.current) return;
    previousSync.current = syncedAt;
    setPending(false);
    toast.success('Membership checked', membershipLabel[state]);
  }, [pending, state, syncedAt, toast]);

  const canJoin = invite !== null && state !== 'MEMBER';
  const badgeTone =
    state === 'MEMBER' ? 'success' : state === 'UNAVAILABLE' ? 'warning' : 'neutral';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={badgeTone}>{membershipLabel[state]}</Badge>
        {state === 'PENDING_SCREENING' ? (
          <p className="text-xs text-ink-muted">
            Finish Discord's welcome questions to access the community.
          </p>
        ) : null}
      </div>

      {error === null ? null : <p className="text-xs text-warning">{error}</p>}

      {!enabled ? (
        <p className="text-xs text-ink-muted">Discord checks are disabled in this environment.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {canJoin ? (
            <Button variant="outline" size="sm" asChild>
              <a href={invite} target="_blank" rel="noopener noreferrer">
                Join the Discord <ArrowUpRight />
              </a>
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            loading={pending}
            disabled={pending}
            onClick={() => {
              previousSync.current = syncedAt;
              setPending(true);
              void resyncDiscordMembershipAction().then((result) => {
                if (!result.ok) {
                  setPending(false);
                  toast.error('Could not check Discord', result.message);
                  return;
                }
                router.refresh();
              });
            }}
          >
            <RefreshCw /> {pending ? 'Checking Discord membership' : 'Check again'}
          </Button>
        </div>
      )}

      {syncedAt === null ? null : (
        <p className="font-mono text-[0.625rem] tracking-wide text-ink-muted">
          Last checked {new Date(syncedAt).toLocaleString('en-GB')}
        </p>
      )}
    </div>
  );
}
