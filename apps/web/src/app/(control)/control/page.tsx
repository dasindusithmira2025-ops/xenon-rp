import Link from 'next/link';

import { queueCounts, statusLabels, statusTones } from '@xenon/applications';
import { prisma } from '@xenon/database';
import { healthReport, ticketCounts } from '@xenon/domain';
import { Badge, Panel } from '@xenon/ui';

import { ControlPage, MetricTile } from '~/components/control/control-page';
import { currentActor } from '~/server/context';

export const dynamic = 'force-dynamic';

/**
 * /control
 *
 * The first screen a staff member sees. Answers one question: what needs a
 * person right now. Every tile is a real count and links to the list behind it,
 * so nothing here is decoration.
 */
export default async function ControlOverview(): Promise<React.ReactElement> {
  const actor = await currentActor();
  const can = (permission: string): boolean => actor.permissions.has(permission as never);

  const [applications, tickets, reports, appeals, players, health, recent] = await Promise.all([
    can('applications.view') ? queueCounts(prisma) : Promise.resolve<Record<string, number>>({}),
    can('tickets.view') ? ticketCounts(prisma) : Promise.resolve(null),
    can('reports.view')
      ? prisma.report.count({ where: { status: { in: ['OPEN', 'INVESTIGATING'] } } })
      : Promise.resolve(null),
    can('appeals.view')
      ? prisma.appeal.count({ where: { status: { in: ['SUBMITTED', 'UNDER_REVIEW'] } } })
      : Promise.resolve(null),
    can('players.view')
      ? prisma.user.count({ where: { deletedAt: null, whitelistState: 'APPROVED' } })
      : Promise.resolve(null),
    healthReport(prisma),
    can('applications.view')
      ? prisma.applicationSubmission.findMany({
          where: { status: { in: ['SUBMITTED', 'RESUBMITTED'] } },
          orderBy: { submittedAt: 'asc' },
          take: 6,
          include: {
            template: { select: { name: true } },
            applicant: { select: { publicId: true, displayName: true } },
          },
        })
      : Promise.resolve([]),
  ]);

  const awaitingReview = (applications.SUBMITTED ?? 0) + (applications.RESUBMITTED ?? 0);
  const inReview = applications.UNDER_REVIEW ?? 0;
  const needsPlayer = tickets?.WAITING_FOR_PLAYER ?? 0;
  const needsStaff = (tickets?.OPEN ?? 0) + (tickets?.WAITING_FOR_STAFF ?? 0);

  const unhealthy = health.checks.filter(
    (check) => check.status === 'UNHEALTHY' || check.status === 'DEGRADED',
  );

  return (
    <ControlPage
      title="Overview"
      lead="What needs a person right now."
      actions={
        <Link
          href="/control/health"
          className={
            unhealthy.length === 0
              ? 'inline-flex items-center gap-2 rounded-sm border border-line-strong px-3 py-1.5 text-xs text-ink-secondary'
              : 'inline-flex items-center gap-2 rounded-sm border border-warning/40 bg-warning/10 px-3 py-1.5 text-xs text-warning'
          }
        >
          {unhealthy.length === 0
            ? 'All systems healthy'
            : `${String(unhealthy.length)} system${unhealthy.length === 1 ? '' : 's'} degraded`}
        </Link>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {can('applications.view') ? (
          <>
            <MetricTile
              label="Awaiting review"
              value={awaitingReview}
              hint="submitted or resubmitted"
              href="/control/applications"
              tone={awaitingReview > 0 ? 'accent' : 'neutral'}
            />
            <MetricTile
              label="In review"
              value={inReview}
              hint="claimed by a reviewer"
              href="/control/applications?status=UNDER_REVIEW"
            />
          </>
        ) : null}

        {tickets === null ? null : (
          <MetricTile
            label="Tickets"
            value={needsStaff}
            hint={`${String(needsPlayer)} waiting on a player`}
            href="/control/tickets"
            tone={needsStaff > 0 ? 'warn' : 'neutral'}
          />
        )}

        {reports === null ? null : (
          <MetricTile
            label="Open reports"
            value={reports}
            href="/control/reports"
            tone={reports > 0 ? 'warn' : 'neutral'}
          />
        )}

        {appeals === null ? null : (
          <MetricTile label="Open appeals" value={appeals} href="/control/appeals" />
        )}

        {players === null ? null : (
          <MetricTile label="Whitelisted" value={players} href="/control/players" />
        )}
      </div>

      {can('applications.view') ? (
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-4">
            <h2 className="x-eyebrow">Oldest waiting</h2>
            <Link
              href="/control/applications"
              className="font-mono text-[0.625rem] tracking-[0.14em] text-ink-muted uppercase transition-colors hover:text-xenon"
            >
              Full queue →
            </Link>
          </div>

          {recent.length === 0 ? (
            <Panel tone="flat" pad="lg">
              <p className="text-sm text-ink-muted">Nothing is waiting. Good.</p>
            </Panel>
          ) : (
            <Panel tone="flat" pad="none" className="divide-y divide-line">
              {recent.map((submission) => (
                <Link
                  key={submission.id}
                  href={`/control/applications/${submission.publicId}`}
                  className="flex flex-wrap items-center justify-between gap-3 p-4 transition-colors hover:bg-elevated"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <p className="truncate text-sm text-ink">
                      {submission.applicant.displayName ?? submission.applicant.publicId}
                      <span className="text-ink-muted"> · {submission.template.name}</span>
                    </p>
                    <p className="font-mono text-[0.625rem] tracking-[0.12em] text-ink-muted">
                      {submission.publicId}
                    </p>
                  </div>

                  <div className="flex items-center gap-3">
                    <span className="font-mono text-[0.625rem] tracking-[0.12em] text-ink-muted uppercase">
                      {submission.submittedAt === null
                        ? '—'
                        : `${String(
                            Math.max(
                              0,
                              Math.floor(
                                (Date.now() - submission.submittedAt.getTime()) / 3_600_000,
                              ),
                            ),
                          )}h ago`}
                    </span>
                    <Badge tone={statusTones[submission.status]}>
                      {statusLabels[submission.status]}
                    </Badge>
                  </div>
                </Link>
              ))}
            </Panel>
          )}
        </section>
      ) : null}

      {unhealthy.length === 0 ? null : (
        <section className="flex flex-col gap-3">
          <h2 className="x-eyebrow">Needs attention</h2>
          <Panel tone="flat" pad="none" className="divide-y divide-line">
            {unhealthy.map((check) => (
              <div key={check.name} className="flex items-center justify-between gap-4 p-4">
                <span className="text-sm text-ink capitalize">{check.name}</span>
                <span className="text-xs text-ink-muted">{check.detail}</span>
                <Badge tone={check.status === 'UNHEALTHY' ? 'danger' : 'warning'}>
                  {check.status.toLowerCase()}
                </Badge>
              </div>
            ))}
          </Panel>
        </section>
      )}
    </ControlPage>
  );
}
