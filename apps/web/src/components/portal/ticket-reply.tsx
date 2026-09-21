'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Button, Field, Panel, Textarea, useToast } from '@xenon/ui';

import { replyToTicketAction } from '~/app/(portal)/portal/actions';

/**
 * Reply to a ticket.
 *
 * Posting flips the ticket to "with staff" inside the service, so the queue
 * stays meaningful without anyone maintaining it by hand.
 */
export function TicketReply({ ticketId }: { ticketId: string }): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [body, setBody] = React.useState('');
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [pending, startTransition] = React.useTransition();

  const submit = (): void => {
    setErrors({});

    startTransition(async () => {
      const result = await replyToTicketAction({
        ticketId,
        body,
        visibility: 'APPLICANT',
        mediaIds: [],
      });

      if (result.ok) {
        setBody('');
        toast.success('Reply sent');
        router.refresh();
        return;
      }

      setErrors(result.fieldErrors ?? {});
      if (result.fieldErrors === undefined) toast.error('Could not send', result.message);
    });
  };

  return (
    <Panel tone="raised" pad="lg" edgeLight>
      <form action={submit} className="flex flex-col gap-4">
        <Field
          label="Reply"
          htmlFor="ticket-reply"
          error={errors.body}
          meta={`${String(body.length)} / 5000`}
        >
          <Textarea
            id="ticket-reply"
            value={body}
            rows={5}
            maxLength={5000}
            autoGrow
            onChange={(event) => {
              setBody(event.target.value);
            }}
          />
        </Field>
        <div className="flex justify-end">
          <Button
            type="submit"
            variant="accent"
            loading={pending}
            disabled={body.trim().length === 0}
          >
            Send reply
          </Button>
        </div>
      </form>
    </Panel>
  );
}
