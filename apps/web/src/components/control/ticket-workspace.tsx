'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Button, cn, Field, Panel, Select, Textarea, useToast } from '@xenon/ui';

import { staffReplyAction, updateTicketAction } from '~/app/(control)/control/actions';

/**
 * Reply and triage controls.
 *
 * The visibility selector is the most important thing on this panel, so it is
 * the largest and the reply box changes colour with it. An internal note typed
 * into a player-visible reply is the mistake this design exists to prevent.
 */
export function TicketWorkspace({
  ticketId,
  status,
  priority,
  assigneeId,
  staff,
  canManage,
  canReply,
}: {
  ticketId: string;
  status: string;
  priority: string;
  assigneeId: string | null;
  staff: readonly { id: string; name: string }[];
  canManage: boolean;
  canReply: boolean;
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [body, setBody] = React.useState('');
  const [visibility, setVisibility] = React.useState<'APPLICANT' | 'INTERNAL'>('APPLICANT');
  const [pending, startTransition] = React.useTransition();

  const run = (action: () => Promise<{ ok: boolean; message?: string }>, success: string): void => {
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        toast.success(success);
        router.refresh();
        return;
      }
      toast.error('That did not go through', result.message ?? 'Try again.');
    });
  };

  const internal = visibility === 'INTERNAL';

  return (
    <>
      {canReply ? (
        <Panel
          tone="raised"
          pad="lg"
          edgeLight
          className={cn('flex flex-col gap-4', internal ? 'border-warning/40' : '')}
        >
          <Select
            value={visibility}
            aria-label="Who sees this"
            className={internal ? 'border-warning/50 text-warning' : ''}
            onChange={(event) => {
              setVisibility(event.target.value === 'INTERNAL' ? 'INTERNAL' : 'APPLICANT');
            }}
          >
            <option value="APPLICANT">Reply to the player</option>
            <option value="INTERNAL">Internal note (player never sees this)</option>
          </Select>

          <Textarea
            value={body}
            rows={6}
            maxLength={5000}
            autoGrow
            placeholder={internal ? 'Context for other staff…' : 'Your reply to the player…'}
            onChange={(event) => {
              setBody(event.target.value);
            }}
          />

          <Button
            variant={internal ? 'outline' : 'accent'}
            loading={pending}
            disabled={body.trim().length === 0}
            onClick={() => {
              run(
                () =>
                  staffReplyAction({ ticketId, body, visibility, mediaIds: [] }).then((result) => {
                    if (result.ok) setBody('');
                    return result;
                  }),
                internal ? 'Note added' : 'Reply sent',
              );
            }}
          >
            {internal ? 'Add internal note' : 'Send reply'}
          </Button>
        </Panel>
      ) : null}

      {canManage ? (
        <Panel tone="flat" pad="lg" className="flex flex-col gap-4">
          <p className="x-eyebrow">Triage</p>

          <Field label="Status" htmlFor="ticket-status">
            <Select
              id="ticket-status"
              value={status}
              disabled={pending}
              onChange={(event) => {
                run(
                  () => updateTicketAction({ ticketId, status: event.target.value, priority }),
                  'Status updated',
                );
              }}
            >
              <option value="OPEN">Open</option>
              <option value="WAITING_FOR_STAFF">Waiting for staff</option>
              <option value="WAITING_FOR_PLAYER">Waiting for player</option>
              <option value="RESOLVED">Resolved</option>
              <option value="CLOSED">Closed</option>
            </Select>
          </Field>

          <Field label="Priority" htmlFor="ticket-priority">
            <Select
              id="ticket-priority"
              value={priority}
              disabled={pending}
              onChange={(event) => {
                run(
                  () => updateTicketAction({ ticketId, status, priority: event.target.value }),
                  'Priority updated',
                );
              }}
            >
              <option value="LOW">Low</option>
              <option value="NORMAL">Normal</option>
              <option value="HIGH">High</option>
              <option value="URGENT">Urgent</option>
            </Select>
          </Field>

          <Field label="Assignee" htmlFor="ticket-assignee">
            <Select
              id="ticket-assignee"
              value={assigneeId ?? ''}
              disabled={pending}
              onChange={(event) => {
                const next = event.target.value;
                run(
                  () =>
                    updateTicketAction({
                      ticketId,
                      status,
                      priority,
                      assigneeId: next === '' ? null : next,
                    }),
                  'Assignee updated',
                );
              }}
            >
              <option value="">Unassigned</option>
              {staff.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </Select>
          </Field>
        </Panel>
      ) : null}
    </>
  );
}
