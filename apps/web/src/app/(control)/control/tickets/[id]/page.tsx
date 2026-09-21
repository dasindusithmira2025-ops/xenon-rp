import Link from 'next/link';
import { notFound } from 'next/navigation';

import { prisma } from '@xenon/database';
import { getTicket } from '@xenon/domain';
import { Avatar, Badge, Panel } from '@xenon/ui';

import { ControlPage } from '~/components/control/control-page';
import { TicketWorkspace } from '~/components/control/ticket-workspace';
import { currentActor, requireCapability } from '~/server/context';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Ticket' };

/**
 * /control/tickets/[id]
 *
 * The staff view of a thread. Internal notes are visible here and are visually
 * distinct from replies, because the single worst outcome on this screen is a
 * staff member typing an internal note into a reply the player then reads.
 */
export default async function ControlTicketPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  await requireCapability('tickets.view');
  const actor = await currentActor();

  const ticket = await getTicket(prisma, actor, id);
  if (ticket === null) notFound();

  const staff = await prisma.user.findMany({
    where: {
      deletedAt: null,
      roles: {
        some: { role: { permissions: { some: { permission: { key: 'tickets.reply' } } } } },
      },
    },
    select: { id: true, displayName: true, publicId: true },
    orderBy: { displayName: 'asc' },
  });

  return (
    <ControlPage
      title={ticket.subject}
      lead={`${ticket.publicId} · ${ticket.category.toLowerCase().replace(/_/g, ' ')} · opened ${ticket.createdAt.toLocaleDateString('en-GB')}`}
      breadcrumb={{ href: '/control/tickets', label: 'Tickets' }}
      actions={
        <Badge tone={ticket.status === 'RESOLVED' ? 'success' : 'neutral'}>
          {ticket.status.toLowerCase().replace(/_/g, ' ')}
        </Badge>
      }
    >
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-4">
          {ticket.messages.map((message) => {
            const internal = message.visibility === 'INTERNAL';
            return (
              <Panel
                key={message.id}
                tone="flat"
                pad="lg"
                className={
                  internal
                    ? 'border-l-2 border-l-warning bg-warning/5'
                    : message.authorId === ticket.authorId
                      ? ''
                      : 'border-l-2 border-l-xenon/40'
                }
              >
                <div className="flex flex-wrap items-center gap-3">
                  <Avatar
                    src={message.author.avatarUrl}
                    name={message.author.displayName}
                    size={24}
                  />
                  <span className="text-xs font-medium text-ink">
                    {message.author.displayName ?? message.author.publicId}
                  </span>
                  {internal ? <Badge tone="warning">Internal note</Badge> : null}
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

        <aside className="flex flex-col gap-4">
          <Panel tone="flat" pad="lg">
            <p className="x-eyebrow">Player</p>
            <Link
              href={`/control/players/${ticket.author.publicId}`}
              className="mt-3 flex items-center gap-3 hover:text-xenon"
            >
              <Avatar src={ticket.author.avatarUrl} name={ticket.author.displayName} size={36} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm text-ink">
                  {ticket.author.displayName ?? ticket.author.publicId}
                </span>
                <span className="font-mono text-[0.625rem] text-ink-muted">
                  {ticket.author.publicId}
                </span>
              </span>
            </Link>
          </Panel>

          <TicketWorkspace
            ticketId={ticket.id}
            status={ticket.status}
            priority={ticket.priority}
            assigneeId={ticket.assigneeId}
            staff={staff.map((member) => ({
              id: member.id,
              name: member.displayName ?? member.publicId,
            }))}
            canManage={actor.permissions.has('tickets.manage')}
            canReply={actor.permissions.has('tickets.reply')}
          />
        </aside>
      </div>
    </ControlPage>
  );
}
