import { ShieldAlert } from 'lucide-react';
import Link from 'next/link';

import { prisma } from '@xenon/database';
import { listReports } from '@xenon/domain';
import { Badge, EmptyState, Panel } from '@xenon/ui';

import { ControlPage } from '~/components/control/control-page';
import { ReportRow } from '~/components/control/report-row';
import { currentActor } from '~/server/context';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Reports' };

/**
 * /control/reports
 *
 * Reports against staff are behind their own capability pair and are filtered
 * at the query, not in the markup. A report accusing a staff member must not
 * appear in a list every staff member can read - including the subject.
 */
export default async function ControlReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const actor = await currentActor();
  const params = await searchParams;

  const kind = typeof params.kind === 'string' ? params.kind : undefined;
  const status = typeof params.status === 'string' ? params.status : undefined;

  const { items, total } = await listReports(prisma, actor, {
    ...(kind === undefined ? {} : { kind: kind as 'PLAYER' | 'STAFF' | 'BUG' }),
    ...(status === undefined
      ? {}
      : {
          status: status as
            'OPEN' | 'INVESTIGATING' | 'AWAITING_INFO' | 'ACTIONED' | 'DISMISSED' | 'CLOSED',
        }),
    take: 50,
  });

  const canSeeStaffReports = actor.permissions.has('reports.staff.view');

  const staffMembers = await prisma.user.findMany({
    where: {
      deletedAt: null,
      roles: {
        some: { role: { permissions: { some: { permission: { key: 'reports.manage' } } } } },
      },
    },
    select: { id: true, displayName: true, publicId: true },
    orderBy: { displayName: 'asc' },
  });

  const kinds = [
    { key: undefined, label: 'All' },
    { key: 'PLAYER', label: 'Players' },
    { key: 'BUG', label: 'Bugs' },
    ...(canSeeStaffReports ? [{ key: 'STAFF', label: 'Staff' }] : []),
  ] as const;

  return (
    <ControlPage
      title="Reports"
      lead={`${String(total)} report${total === 1 ? '' : 's'} you can see.`}
    >
      {canSeeStaffReports ? (
        <Panel tone="ghost" pad="md" className="border-warning/25 bg-warning/5">
          <p className="flex items-start gap-2.5 text-xs leading-relaxed text-warning">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            You can see reports filed against staff. Most staff cannot. Handle them accordingly, and
            recuse yourself from anything involving you.
          </p>
        </Panel>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {kinds.map((entry) => (
          <Link
            key={entry.label}
            href={
              entry.key === undefined ? '/control/reports' : `/control/reports?kind=${entry.key}`
            }
            className={
              kind === entry.key
                ? 'rounded-sm border border-xenon/40 bg-xenon-deep/20 px-3 py-1.5 text-xs text-xenon'
                : 'rounded-sm border border-line-strong px-3 py-1.5 text-xs text-ink-muted transition-colors hover:text-ink-secondary'
            }
          >
            {entry.label}
          </Link>
        ))}
      </div>

      {items.length === 0 ? (
        <EmptyState title="No reports" description="Nothing matches this filter." />
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((report) => (
            <ReportRow
              key={report.id}
              report={{
                id: report.id,
                publicId: report.publicId,
                kind: report.kind,
                status: report.status,
                priority: report.priority,
                summary: report.summary,
                details: report.details,
                outcome: report.outcome,
                createdAt: report.createdAt.toISOString(),
                occurredAt: report.occurredAt?.toISOString() ?? null,
                reporterName: report.reporter?.displayName ?? report.reporter?.publicId ?? null,
                subjectName:
                  report.subject?.displayName ?? report.subject?.publicId ?? report.subjectLabel,
                subjectPublicId: report.subject?.publicId ?? null,
                assigneeId: report.assigneeId,
              }}
              staff={staffMembers.map((member) => ({
                id: member.id,
                name: member.displayName ?? member.publicId,
              }))}
              canManage={
                report.kind === 'STAFF'
                  ? actor.permissions.has('reports.staff.manage')
                  : actor.permissions.has('reports.manage')
              }
            />
          ))}
        </div>
      )}

      {status === undefined ? null : <Badge tone="neutral">Filtered by {status}</Badge>}
    </ControlPage>
  );
}
