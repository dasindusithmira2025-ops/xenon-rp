import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { prisma } from '@xenon/database';
import { getTicket } from '@xenon/domain';
import { Avatar, Badge, Panel } from '@xenon/ui';

import type { Metadata } from 'next';

import { PortalPage } from '~/components/portal/portal-page';
import { TicketReply } from '~/components/portal/ticket-reply';
import { currentActor } from '~/server/context';

export const metadata: Metadata = {
  title: 'Ticket',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const ticketTone = {
  OPEN: 'info',
  WAITING_FOR_STAFF: 'warning',
  WAITING_FOR_PLAYER: 'attention',
  RESOLVED: 'success',
  CLOSED: 'neutral',
} as const;

/**
 * One ticket thread.
 *
 * `getTicket` filters internal staff notes out at the query rather than in the
 * view, so a component that forgets to check cannot leak them.
 */
export default async function TicketPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  const actor = await currentActor();

  const ticket = await getTicket(prisma, actor, id);
  if (ticket === null) notFound();

  const closed = ticket.status === 'CLOSED';

  return (
    <PortalPage
      title={ticket.subject}
      lead={`${ticket.publicId} · opened ${ticket.createdAt.toLocaleDateString('en-GB')}`}
      actions={
        <Badge tone={ticketTone[ticket.status]}>
          {ticket.status.toLowerCase().replace(/_/g, ' ')}
        </Badge>
      }
    >
      <Link
        href="/portal/tickets"
        className="inline-flex items-center gap-2 font-mono text-[0.6875rem] tracking-[0.16em] text-ink-muted uppercase transition-colors hover:text-xenon"
      >
        <ArrowLeft className="size-3.5" /> All tickets
      </Link>

      <div className="flex flex-col gap-4">
        {ticket.messages.map((message) => {
          const mine = message.authorId === actor.userId;
          return (
            <Panel
              key={message.id}
              tone={mine ? 'flat' : 'raised'}
              pad="lg"
              className={mine ? 'sm:ml-10' : 'sm:mr-10 border-l-2 border-l-xenon/40'}
            >
              <div className="flex items-center gap-3">
                <Avatar
                  src={message.author.avatarUrl}
                  name={message.author.displayName}
                  size={28}
                />
                <span className="text-sm font-medium text-ink">
                  {mine ? 'You' : (message.author.displayName ?? 'Xenon staff')}
                </span>
                <time
                  className="ml-auto font-mono text-[0.625rem] tracking-[0.12em] text-ink-muted uppercase"
                  dateTime={message.createdAt.toISOString()}
                >
                  {message.createdAt.toLocaleString('en-GB', {
                    day: '2-digit',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </time>
              </div>
              <p className="mt-3 text-sm leading-relaxed whitespace-pre-wrap text-ink-secondary">
                {message.body}
              </p>
            </Panel>
          );
        })}
      </div>

      {closed ? (
        <Panel tone="ghost" pad="lg">
          <p className="text-sm text-ink-muted">
            This ticket is closed. Open a new one if you need anything else.
          </p>
        </Panel>
      ) : (
        <TicketReply ticketId={ticket.id} />
      )}
    </PortalPage>
  );
}
