'use client';

import { Check, MessageSquare, UserCheck, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import {
  Badge,
  Button,
  ConfirmDialog,
  Field,
  Input,
  Panel,
  Select,
  Textarea,
  useToast,
} from '@xenon/ui';

import {
  approveAction,
  assignAction,
  claimAction,
  commentAction,
  completeInterviewAction,
  rejectAction,
  requestChangesAction,
  requestInterviewAction,
  scheduleInterviewAction,
} from '~/app/(control)/control/applications/actions';
import { text } from '~/lib/form';

/**
 * The reviewer's action panel.
 *
 * Two deliberate decisions:
 *
 *  - Approve, reject and request-changes all go through a confirmation. These
 *    are the decisions a player reads as final, and a misclick on a list of
 *    forty applications is not hypothetical.
 *  - Assignment is advisory. The panel says who is reviewing and warns before
 *    taking over, but does not lock the record - a hard lock strands
 *    applications behind whoever opened one and went to bed.
 */

export interface ReviewActionsProps {
  readonly reference: string;
  readonly status: string;
  readonly assignee: { id: string; name: string } | null;
  readonly viewerId: string;
  readonly reviewers: readonly { id: string; name: string }[];
  readonly can: {
    readonly review: boolean;
    readonly assign: boolean;
    readonly approve: boolean;
    readonly reject: boolean;
    readonly requestChanges: boolean;
    readonly interview: boolean;
  };
  readonly grantsWhitelist: boolean;
  readonly grantRoleKeys: readonly string[];
}

type Decision = 'approve' | 'reject' | 'changes' | null;

export function ReviewActions({
  reference,
  status,
  assignee,
  viewerId,
  reviewers,
  can,
  grantsWhitelist,
  grantRoleKeys,
}: ReviewActionsProps): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = React.useTransition();

  const [publicNote, setPublicNote] = React.useState('');
  const [staffNote, setStaffNote] = React.useState('');
  const [decision, setDecision] = React.useState<Decision>(null);

  const decided =
    status === 'APPROVED' ||
    status === 'REJECTED' ||
    status === 'WITHDRAWN' ||
    status === 'EXPIRED' ||
    status === 'ARCHIVED';

  const mine = assignee?.id === viewerId;
  const takenBySomeoneElse = assignee !== null && !mine;

  const run = (action: () => Promise<{ ok: boolean; message?: string }>, success: string): void => {
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        toast.success(success);
        setDecision(null);
        setPublicNote('');
        setStaffNote('');
        router.refresh();
        return;
      }
      toast.error('That did not go through', result.message ?? 'Try again.');
    });
  };

  if (decided) {
    return (
      <Panel tone="flat" pad="lg" className="flex flex-col gap-3">
        <p className="x-eyebrow">Decided</p>
        <p className="text-sm text-ink-secondary">
          This application is {status.toLowerCase().replace(/_/g, ' ')}. Decisions are not reversed
          in place - the applicant reapplies or appeals.
        </p>
      </Panel>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-4">
        <Panel tone="raised" pad="lg" edgeLight className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <p className="x-eyebrow">Reviewer</p>
            {assignee === null ? (
              <Badge tone="neutral">Unassigned</Badge>
            ) : (
              <Badge tone={mine ? 'success' : 'warning'}>{mine ? 'You' : assignee.name}</Badge>
            )}
          </div>

          {takenBySomeoneElse ? (
            <p className="rounded-md border border-warning/30 bg-warning/5 p-3 text-xs leading-relaxed text-warning">
              {assignee.name} is reviewing this. You can still act on it, but check with them first.
            </p>
          ) : null}

          {can.review && !mine ? (
            <Button
              variant="outline"
              loading={pending}
              onClick={() => {
                run(() => claimAction(reference), 'Claimed');
              }}
            >
              <UserCheck /> {assignee === null ? 'Claim this' : 'Take over'}
            </Button>
          ) : null}

          {can.assign ? (
            <Field label="Assign to" htmlFor="assignee">
              <Select
                id="assignee"
                value={assignee?.id ?? ''}
                disabled={pending}
                onChange={(event) => {
                  const next = event.target.value;
                  run(
                    () => assignAction(reference, next === '' ? null : next),
                    next === '' ? 'Returned to the queue' : 'Assigned',
                  );
                }}
              >
                <option value="">Unassigned</option>
                {reviewers.map((reviewer) => (
                  <option key={reviewer.id} value={reviewer.id}>
                    {reviewer.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
        </Panel>

        <Panel tone="flat" pad="lg" className="flex flex-col gap-4">
          <p className="x-eyebrow">Notes</p>

          <Field
            label="Message to the applicant"
            htmlFor="public-note"
            hint="Shown to them, and included in the notification. Required for a rejection or a change request; optional interview instructions."
          >
            <Textarea
              id="public-note"
              value={publicNote}
              rows={4}
              maxLength={2000}
              onChange={(event) => {
                setPublicNote(event.target.value);
              }}
            />
          </Field>

          <Field label="Internal note" htmlFor="staff-note" hint="Staff only. Never shown.">
            <Textarea
              id="staff-note"
              value={staffNote}
              rows={3}
              maxLength={2000}
              onChange={(event) => {
                setStaffNote(event.target.value);
              }}
            />
          </Field>
        </Panel>

        <div className="flex flex-col gap-2">
          {can.approve ? (
            <Button
              variant="accent"
              size="lg"
              disabled={pending}
              onClick={() => {
                setDecision('approve');
              }}
            >
              <Check /> Approve
            </Button>
          ) : null}

          {can.requestChanges ? (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => {
                if (publicNote.trim().length < 10) {
                  toast.error(
                    'Say what needs changing',
                    'The applicant only sees the message you write here.',
                  );
                  return;
                }
                setDecision('changes');
              }}
            >
              Request changes
            </Button>
          ) : null}

          {can.interview && status !== 'INTERVIEW_REQUIRED' ? (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => {
                run(
                  () => requestInterviewAction(reference, publicNote, staffNote),
                  'Moved to the interview stage',
                );
              }}
            >
              Request an interview
            </Button>
          ) : null}

          {can.reject ? (
            <Button
              variant="danger"
              disabled={pending}
              onClick={() => {
                if (publicNote.trim().length < 10) {
                  toast.error(
                    'A rejection needs a reason',
                    'The applicant sees this, and a rejection they cannot understand becomes a ticket.',
                  );
                  return;
                }
                setDecision('reject');
              }}
            >
              <X /> Reject
            </Button>
          ) : null}
        </div>

        {status === 'INTERVIEW_REQUIRED' || status === 'INTERVIEW_SCHEDULED' ? (
          <InterviewPanel reference={reference} status={status} pending={pending} onRun={run} />
        ) : null}

        <CommentBox reference={reference} />
      </div>

      <ConfirmDialog
        open={decision === 'approve'}
        onOpenChange={(open) => {
          if (!open) setDecision(null);
        }}
        title="Approve this application?"
        description={
          <>
            The applicant is notified immediately.
            {grantsWhitelist ? ' This grants whitelist access.' : ''}
            {grantRoleKeys.length > 0 ? ` Roles granted: ${grantRoleKeys.join(', ')}.` : ''} Discord
            roles and the game server are synchronised afterwards, and retried if either is down.
          </>
        }
        confirmLabel="Approve"
        loading={pending}
        onConfirm={() => {
          run(() => approveAction(reference, publicNote, staffNote), 'Approved');
        }}
      />

      <ConfirmDialog
        open={decision === 'reject'}
        onOpenChange={(open) => {
          if (!open) setDecision(null);
        }}
        title="Reject this application?"
        description="The applicant is notified with the message you wrote. They can reapply after the template's cooldown."
        confirmLabel="Reject"
        tone="danger"
        loading={pending}
        onConfirm={() => {
          run(() => rejectAction(reference, publicNote, staffNote), 'Rejected');
        }}
      />

      <ConfirmDialog
        open={decision === 'changes'}
        onOpenChange={(open) => {
          if (!open) setDecision(null);
        }}
        title="Send this back for changes?"
        description="The applicant can edit and resubmit. Their expiry window restarts so they have time to act on the feedback."
        confirmLabel="Request changes"
        loading={pending}
        onConfirm={() => {
          run(
            () => requestChangesAction(reference, publicNote, staffNote),
            'Sent back for changes',
          );
        }}
      />
    </>
  );
}

function InterviewPanel({
  reference,
  status,
  pending,
  onRun,
}: {
  reference: string;
  status: string;
  pending: boolean;
  onRun: (action: () => Promise<{ ok: boolean; message?: string }>, success: string) => void;
}): React.ReactElement {
  return (
    <Panel tone="flat" pad="lg" className="flex flex-col gap-4">
      <p className="x-eyebrow">Interview</p>

      {status === 'INTERVIEW_REQUIRED' ? (
        <form
          className="flex flex-col gap-3"
          action={(form) => {
            onRun(
              () =>
                scheduleInterviewAction(
                  reference,
                  text(form, 'scheduledFor'),
                  text(form, 'location'),
                ),
              'Interview scheduled',
            );
          }}
        >
          <Field label="When" htmlFor="scheduledFor" required>
            <Input name="scheduledFor" type="datetime-local" required />
          </Field>
          <Field label="Where" htmlFor="location" hint="A voice channel or a meeting link.">
            <Input name="location" maxLength={200} />
          </Field>
          <Button type="submit" variant="accent" loading={pending}>
            Schedule
          </Button>
        </form>
      ) : (
        <form
          className="flex flex-col gap-3"
          action={(form) => {
            const outcome = text(form, 'outcome');
            onRun(
              () =>
                completeInterviewAction(
                  reference,
                  outcome === 'PASSED' || outcome === 'FAILED' ? outcome : 'INCONCLUSIVE',
                  text(form, 'notes'),
                ),
              'Interview recorded',
            );
          }}
        >
          <Field label="Outcome" htmlFor="outcome" required>
            <Select name="outcome" defaultValue="PASSED">
              <option value="PASSED">Passed</option>
              <option value="INCONCLUSIVE">Inconclusive</option>
              <option value="FAILED">Failed</option>
            </Select>
          </Field>
          <Field label="Notes" htmlFor="notes">
            <Textarea name="notes" rows={3} maxLength={2000} />
          </Field>
          <Button type="submit" variant="accent" loading={pending}>
            Record outcome
          </Button>
        </form>
      )}
    </Panel>
  );
}

function CommentBox({ reference }: { reference: string }): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = React.useTransition();
  const [body, setBody] = React.useState('');
  const [visibility, setVisibility] = React.useState<'INTERNAL' | 'APPLICANT'>('INTERNAL');

  return (
    <Panel tone="flat" pad="lg">
      <form
        className="flex flex-col gap-3"
        action={() => {
          if (body.trim().length === 0) return;
          startTransition(async () => {
            const result = await commentAction(reference, body, visibility);
            if (result.ok) {
              setBody('');
              toast.success(visibility === 'INTERNAL' ? 'Note added' : 'Sent to the applicant');
              router.refresh();
              return;
            }
            toast.error('Could not save that', result.message);
          });
        }}
      >
        <p className="x-eyebrow flex items-center gap-2">
          <MessageSquare className="size-3" aria-hidden /> Add a note
        </p>

        <Textarea
          value={body}
          rows={3}
          maxLength={4000}
          placeholder="Context for the next reviewer, or a message to the applicant."
          onChange={(event) => {
            setBody(event.target.value);
          }}
        />

        <div className="flex items-center gap-2">
          <Select
            value={visibility}
            aria-label="Visibility"
            className="h-9 flex-1 text-xs"
            onChange={(event) => {
              setVisibility(event.target.value === 'APPLICANT' ? 'APPLICANT' : 'INTERNAL');
            }}
          >
            <option value="INTERNAL">Staff only</option>
            <option value="APPLICANT">Visible to the applicant</option>
          </Select>
          <Button type="submit" variant="outline" size="sm" loading={pending}>
            Add
          </Button>
        </div>
      </form>
    </Panel>
  );
}
