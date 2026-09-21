'use client';

import { ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Avatar, Badge, Button, ConfirmDialog, Panel, Select, Textarea, useToast } from '@xenon/ui';

import { decideAppealAction } from '~/app/(control)/control/actions';

/**
 * One appeal, expandable.
 *
 * Accepting or denying is confirmed: both are final in the state machine, the
 * player is notified immediately, and neither can be taken back in place.
 */

export interface AppealRecord {
  readonly id: string;
  readonly publicId: string;
  readonly kind: string;
  readonly status: string;
  readonly statement: string;
  readonly sanctionRef: string | null;
  readonly decision: string | null;
  readonly createdAt: string;
  readonly authorName: string;
  readonly authorPublicId: string;
  readonly authorAvatar: string | null;
}

const statusTone: Record<
  string,
  'info' | 'warning' | 'attention' | 'success' | 'danger' | 'neutral'
> = {
  SUBMITTED: 'info',
  UNDER_REVIEW: 'warning',
  AWAITING_INFO: 'attention',
  ACCEPTED: 'success',
  DENIED: 'danger',
  WITHDRAWN: 'neutral',
};

export function AppealRow({
  appeal,
  canManage,
}: {
  appeal: AppealRecord;
  canManage: boolean;
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [decision, setDecision] = React.useState(appeal.decision ?? '');
  const [confirming, setConfirming] = React.useState<'ACCEPTED' | 'DENIED' | null>(null);
  const [pending, startTransition] = React.useTransition();

  const decided =
    appeal.status === 'ACCEPTED' || appeal.status === 'DENIED' || appeal.status === 'WITHDRAWN';

  const submit = (status: string): void => {
    startTransition(async () => {
      const result = await decideAppealAction({ appealId: appeal.id, status, decision });
      if (result.ok) {
        toast.success('Appeal updated');
        setConfirming(null);
        router.refresh();
        return;
      }
      toast.error('That did not go through', result.message);
    });
  };

  return (
    <Panel tone="flat" pad="none" className="overflow-hidden">
      <button
        type="button"
        onClick={() => {
          setOpen((current) => !current);
        }}
        aria-expanded={open}
        className="flex w-full items-center gap-4 p-4 text-left transition-colors hover:bg-elevated"
      >
        <Avatar src={appeal.authorAvatar} name={appeal.authorName} size={28} />

        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-sm text-ink">{appeal.authorName}</span>
          <span className="font-mono text-[0.625rem] tracking-[0.12em] text-ink-muted">
            {appeal.publicId} · {appeal.kind.toLowerCase().replace(/_/g, ' ')} ·{' '}
            {new Date(appeal.createdAt).toLocaleDateString('en-GB')}
          </span>
        </span>

        <Badge tone={statusTone[appeal.status] ?? 'neutral'}>
          {appeal.status.toLowerCase().replace(/_/g, ' ')}
        </Badge>
        <ChevronDown
          className={`size-4 shrink-0 text-ink-muted transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>

      {open ? (
        <div className="grid gap-5 border-t border-line p-5 lg:grid-cols-[minmax(0,1fr)_16rem]">
          <div className="flex min-w-0 flex-col gap-4">
            <div className="flex items-center gap-4 text-xs">
              <Link
                href={`/control/players/${appeal.authorPublicId}`}
                className="font-mono text-xenon hover:underline"
              >
                {appeal.authorPublicId}
              </Link>
              {appeal.sanctionRef === null ? null : (
                <span className="text-ink-muted">Reference: {appeal.sanctionRef}</span>
              )}
            </div>

            <div>
              <p className="x-eyebrow">Their statement</p>
              <p className="mt-2 rounded-md border border-line bg-black p-4 text-sm leading-relaxed whitespace-pre-wrap text-ink-secondary">
                {appeal.statement}
              </p>
            </div>

            {appeal.decision === null ? null : (
              <div>
                <p className="x-eyebrow">Recorded decision</p>
                <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-ink-secondary">
                  {appeal.decision}
                </p>
              </div>
            )}
          </div>

          {canManage && !decided ? (
            <div className="flex flex-col gap-3">
              <Textarea
                value={decision}
                rows={6}
                maxLength={4000}
                placeholder="What you decided and why. The player reads this."
                onChange={(event) => {
                  setDecision(event.target.value);
                }}
              />

              <Select
                value={appeal.status}
                aria-label="Move to"
                disabled={pending}
                onChange={(event) => {
                  const next = event.target.value;
                  if (next === 'ACCEPTED' || next === 'DENIED') {
                    if (decision.trim().length < 10) {
                      toast.error(
                        'Write the decision first',
                        'The player only sees what you type here.',
                      );
                      return;
                    }
                    setConfirming(next);
                    return;
                  }
                  submit(next);
                }}
              >
                <option value="UNDER_REVIEW">Under review</option>
                <option value="AWAITING_INFO">Awaiting info</option>
                <option value="ACCEPTED">Accept</option>
                <option value="DENIED">Deny</option>
              </Select>

              <Button
                variant="outline"
                size="sm"
                loading={pending}
                onClick={() => {
                  submit(appeal.status === 'SUBMITTED' ? 'UNDER_REVIEW' : appeal.status);
                }}
              >
                Save notes
              </Button>
            </div>
          ) : (
            <p className="text-xs text-ink-muted">
              {decided ? 'This appeal has been decided.' : 'You can read this but not decide it.'}
            </p>
          )}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(next) => {
          if (!next) setConfirming(null);
        }}
        title={confirming === 'ACCEPTED' ? 'Accept this appeal?' : 'Deny this appeal?'}
        description="The player is notified with your decision. Appeals cannot be reopened once decided."
        confirmLabel={confirming === 'ACCEPTED' ? 'Accept' : 'Deny'}
        tone={confirming === 'ACCEPTED' ? 'accent' : 'danger'}
        loading={pending}
        onConfirm={() => {
          if (confirming !== null) submit(confirming);
        }}
      />
    </Panel>
  );
}
