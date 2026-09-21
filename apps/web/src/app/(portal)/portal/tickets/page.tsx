import { Plus } from 'lucide-react';
import Link from 'next/link';

import { prisma } from '@xenon/database';
import { listOwnReports, listTickets } from '@xenon/domain';
import { Badge, Button, EmptyState, Panel } from '@xenon/ui';

import type { Metadata } from 'next';

import { PortalPage, PortalSection } from '~/components/portal/portal-page';
import { requireUserId } from '~/server/context';

export const metadata: Metadata = {
  title: 'Support',
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

const ticketLabel = {
  OPEN: 'Open',
  WAITING_FOR_STAFF: 'With staff',
  WAITING_FOR_PLAYER: 'Needs you',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
} as const;

const reportTone = {
  OPEN: 'info',
  INVESTIGATING: 'warning',
  AWAITING_INFO: 'attention',
  ACTIONED: 'success',
  DISMISSED: 'neutral',
  CLOSED: 'neutral',
} as const;

export default async function PortalTicketsPage(): Promise<React.ReactElement> {
  const userId = await requireUserId();

  const [{ items: tickets }, reports] = await Promise.all([
    listTickets(prisma, { authorId: userId, take: 50 }),
    listOwnReports(prisma, userId),
  ]);

  return (
    <PortalPage
      title="Support"
      lead="Your tickets and the reports you have filed."
      actions={
        <Button variant="accent" asChild>
          <Link href="/support">
            <Plus /> New ticket
          </Link>
        </Button>
      }
    >
      <PortalSection title="Tickets">
        {tickets.length === 0 ? (
          <EmptyState
            title="No tickets"
            description="Open one from the support page and a member of staff will pick it up."
            action={
              <Button variant="accent" asChild>
                <Link href="/support">Open a ticket</Link>
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col gap-3">
            {tickets.map((ticket) => (
              <Link
                key={ticket.id}
                href={`/portal/tickets/${ticket.publicId}`}
                className="group flex flex-wrap items-center justify-between gap-4 rounded-lg border border-line bg-surface p-5 transition-colors hover:border-chrome-500"
              >
                <div className="flex min-w-0 flex-col gap-1.5">
                  <p className="truncate font-medium text-ink transition-colors group-hover:text-xenon">
                    {ticket.subject}
                  </p>
                  <p className="font-mono text-[0.6875rem] tracking-[0.14em] text-ink-muted">
                    {ticket.publicId} · {ticket._count.messages} message
                    {ticket._count.messages === 1 ? '' : 's'}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="hidden font-mono text-[0.625rem] tracking-[0.12em] text-ink-muted uppercase sm:inline">
                    {ticket.lastMessageAt.toLocaleDateString('en-GB')}
                  </span>
                  <Badge tone={ticketTone[ticket.status]}>{ticketLabel[ticket.status]}</Badge>
                </div>
              </Link>
            ))}
          </div>
        )}
      </PortalSection>

      {reports.length === 0 ? null : (
        <PortalSection
          title="Reports you filed"
          description="You are told when the state changes, never what action was taken against another player."
        >
          <Panel tone="flat" pad="none" className="divide-y divide-line">
            {reports.map((report) => (
              <div key={report.id} className="flex items-center justify-between gap-4 p-4">
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="truncate text-sm text-ink">{report.summary}</p>
                  <p className="font-mono text-[0.625rem] tracking-[0.12em] text-ink-muted">
                    {report.publicId} · {report.kind.toLowerCase()}
                  </p>
                </div>
                <Badge tone={reportTone[report.status]}>
                  {report.status.toLowerCase().replace(/_/g, ' ')}
                </Badge>
              </div>
            ))}
          </Panel>
        </PortalSection>
      )}
    </PortalPage>
  );
}
