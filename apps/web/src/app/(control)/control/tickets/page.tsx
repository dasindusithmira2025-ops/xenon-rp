import Link from 'next/link';

import { prisma } from '@xenon/database';
import { listTickets, ticketCounts } from '@xenon/domain';
import { Avatar, Badge, EmptyState, TBody, TD, TH, THead, Table, TableShell, TR } from '@xenon/ui';

import { ControlPage } from '~/components/control/control-page';
import { requireCapability } from '~/server/context';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Tickets' };

const tone: Record<string, 'info' | 'warning' | 'attention' | 'success' | 'neutral'> = {
  OPEN: 'info',
  WAITING_FOR_STAFF: 'warning',
  WAITING_FOR_PLAYER: 'attention',
  RESOLVED: 'success',
  CLOSED: 'neutral',
};

const priorityTone: Record<string, 'neutral' | 'warning' | 'danger'> = {
  LOW: 'neutral',
  NORMAL: 'neutral',
  HIGH: 'warning',
  URGENT: 'danger',
};

/**
 * /control/tickets
 *
 * Ordered by last message rather than by creation: the queue is about what has
 * moved, not what is oldest, and a ticket the player replied to five minutes
 * ago is the one that needs looking at.
 */
export default async function ControlTicketsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  await requireCapability('tickets.view');
  const params = await searchParams;

  const status = typeof params.status === 'string' ? params.status : undefined;
  const search = typeof params.q === 'string' ? params.q : undefined;

  const [{ items, total }, counts] = await Promise.all([
    listTickets(prisma, {
      ...(status === undefined
        ? {}
        : {
            status: status as
              'OPEN' | 'WAITING_FOR_STAFF' | 'WAITING_FOR_PLAYER' | 'RESOLVED' | 'CLOSED',
          }),
      ...(search === undefined ? {} : { search }),
      take: 50,
    }),
    ticketCounts(prisma),
  ]);

  const filters = [
    { key: undefined, label: 'All', count: total },
    { key: 'OPEN', label: 'Open', count: counts.OPEN },
    { key: 'WAITING_FOR_STAFF', label: 'With staff', count: counts.WAITING_FOR_STAFF },
    { key: 'WAITING_FOR_PLAYER', label: 'With player', count: counts.WAITING_FOR_PLAYER },
    { key: 'RESOLVED', label: 'Resolved', count: counts.RESOLVED },
    { key: 'CLOSED', label: 'Closed', count: counts.CLOSED },
  ] as const;

  return (
    <ControlPage title="Tickets" lead="Support conversations, newest activity first.">
      <div className="flex flex-wrap gap-2">
        {filters.map((filter) => {
          const active = status === filter.key;
          return (
            <Link
              key={filter.label}
              href={
                filter.key === undefined
                  ? '/control/tickets'
                  : `/control/tickets?status=${filter.key}`
              }
              className={
                active
                  ? 'rounded-sm border border-xenon/40 bg-xenon-deep/20 px-3 py-1.5 text-xs text-xenon'
                  : 'rounded-sm border border-line-strong px-3 py-1.5 text-xs text-ink-muted transition-colors hover:text-ink-secondary'
              }
            >
              {filter.label}
              <span className="x-tabular ml-2 text-ink-muted">{filter.count}</span>
            </Link>
          );
        })}
      </div>

      {items.length === 0 ? (
        <EmptyState title="No tickets" description="Nothing matches this filter." />
      ) : (
        <TableShell>
          <Table>
            <THead>
              <TH width="8rem">Reference</TH>
              <TH>Subject</TH>
              <TH width="12rem">Player</TH>
              <TH width="10rem">Assignee</TH>
              <TH width="7rem">Priority</TH>
              <TH width="9rem">Status</TH>
              <TH width="7rem" align="right">
                Updated
              </TH>
            </THead>
            <TBody>
              {items.map((ticket) => (
                <TR key={ticket.id}>
                  <TD>
                    <Link
                      href={`/control/tickets/${ticket.publicId}`}
                      className="font-mono text-xs text-xenon hover:underline"
                    >
                      {ticket.publicId}
                    </Link>
                  </TD>
                  <TD>
                    <Link href={`/control/tickets/${ticket.publicId}`} className="hover:text-ink">
                      <span className="block truncate">{ticket.subject}</span>
                      <span className="font-mono text-[0.625rem] text-ink-muted">
                        {ticket.category.toLowerCase().replace(/_/g, ' ')}
                      </span>
                    </Link>
                  </TD>
                  <TD>
                    <span className="flex items-center gap-2">
                      <Avatar
                        src={ticket.author.avatarUrl}
                        name={ticket.author.displayName}
                        size={20}
                      />
                      <span className="truncate">
                        {ticket.author.displayName ?? ticket.author.publicId}
                      </span>
                    </span>
                  </TD>
                  <TD>{ticket.assignee?.displayName ?? '—'}</TD>
                  <TD>
                    <Badge tone={priorityTone[ticket.priority] ?? 'neutral'}>
                      {ticket.priority.toLowerCase()}
                    </Badge>
                  </TD>
                  <TD>
                    <Badge tone={tone[ticket.status] ?? 'neutral'}>
                      {ticket.status.toLowerCase().replace(/_/g, ' ')}
                    </Badge>
                  </TD>
                  <TD align="right" className="x-tabular text-xs">
                    {ticket.lastMessageAt.toLocaleDateString('en-GB')}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableShell>
      )}
    </ControlPage>
  );
}
