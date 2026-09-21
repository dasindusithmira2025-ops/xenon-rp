import Link from 'next/link';

import { listReviewQueue, statusLabels, statusTones } from '@xenon/applications';
import type { ApplicationStatus } from '@xenon/database';
import { prisma } from '@xenon/database';
import { Avatar, Badge, EmptyState, TBody, TD, TH, THead, Table, TableShell, TR } from '@xenon/ui';

import { ControlPage } from '~/components/control/control-page';
import { QueueFilters } from '~/components/control/queue-filters';
import { requireCapability } from '~/server/context';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Review queue' };

const PAGE_SIZE = 25;

/**
 * /control/applications
 *
 * The queue, oldest first. That ordering is the whole point: the queue exists
 * to answer "what should I pick up next", and newest-first starves whoever has
 * waited longest.
 *
 * A table rather than cards. Staff scan a hundred of these, and comparing rows
 * is what a table is for.
 */
export default async function ReviewQueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const actor = await requireCapability('applications.view');
  const params = await searchParams;

  const single = (key: string): string | undefined => {
    const value = params[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };

  const status = single('status') as ApplicationStatus | undefined;
  const templateId = single('template');
  const search = single('q');
  const mine = single('mine') === '1';
  const page = Math.max(1, Number(single('page') ?? '1'));

  const [{ items, total }, templates] = await Promise.all([
    listReviewQueue(prisma, actor, {
      ...(status === undefined ? {} : { status }),
      ...(templateId === undefined ? {} : { templateId }),
      ...(search === undefined ? {} : { search }),
      ...(mine ? { assigneeId: actor.userId } : {}),
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.applicationTemplate.findMany({
      where: { status: { not: 'ARCHIVED' } },
      select: { id: true, name: true },
      orderBy: { sortOrder: 'asc' },
    }),
  ]);

  return (
    <ControlPage
      title="Review queue"
      lead={`${String(total)} application${total === 1 ? '' : 's'} matching this filter, oldest first.`}
    >
      <QueueFilters templates={templates} />

      {items.length === 0 ? (
        <EmptyState
          title="Nothing here"
          description="Either the queue is clear or the filter is too narrow."
        />
      ) : (
        <>
          <TableShell>
            <Table>
              <THead>
                <TH width="9rem">Reference</TH>
                <TH>Applicant</TH>
                <TH width="12rem">Type</TH>
                <TH width="10rem">Reviewer</TH>
                <TH width="7rem">Waiting</TH>
                <TH width="10rem">Status</TH>
              </THead>
              <TBody>
                {items.map((submission) => {
                  const waitingHours =
                    submission.submittedAt === null
                      ? null
                      : Math.floor((Date.now() - submission.submittedAt.getTime()) / 3_600_000);

                  return (
                    <TR key={submission.id}>
                      <TD>
                        <Link
                          href={`/control/applications/${submission.publicId}`}
                          className="font-mono text-xs text-xenon hover:underline"
                        >
                          {submission.publicId}
                        </Link>
                      </TD>

                      <TD>
                        <Link
                          href={`/control/applications/${submission.publicId}`}
                          className="flex items-center gap-2.5 hover:text-ink"
                        >
                          <Avatar
                            src={submission.applicant.avatarUrl}
                            name={submission.applicant.displayName}
                            size={24}
                          />
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate text-ink">
                              {submission.applicant.displayName ?? submission.applicant.publicId}
                            </span>
                            {submission.applicant.discordAccount === null ? null : (
                              <span className="truncate font-mono text-[0.625rem] text-ink-muted">
                                {submission.applicant.discordAccount.username}
                              </span>
                            )}
                          </span>
                        </Link>
                      </TD>

                      <TD>{submission.template.name}</TD>

                      <TD>
                        {submission.assignee === null ? (
                          <span className="text-ink-muted">—</span>
                        ) : (
                          <span className="flex items-center gap-2">
                            <Avatar
                              src={submission.assignee.avatarUrl}
                              name={submission.assignee.displayName}
                              size={20}
                            />
                            <span className="truncate">
                              {submission.assignee.displayName ?? submission.assignee.publicId}
                            </span>
                          </span>
                        )}
                      </TD>

                      <TD align="right">
                        {waitingHours === null ? (
                          <span className="text-ink-muted">—</span>
                        ) : (
                          <span
                            className={
                              // 72 hours is the point at which a queue stops
                              // feeling like a queue to the person waiting.
                              waitingHours > 72
                                ? 'x-tabular text-warning'
                                : 'x-tabular text-ink-secondary'
                            }
                          >
                            {waitingHours < 24
                              ? `${String(waitingHours)}h`
                              : `${String(Math.floor(waitingHours / 24))}d`}
                          </span>
                        )}
                      </TD>

                      <TD>
                        <Badge tone={statusTones[submission.status]}>
                          {statusLabels[submission.status]}
                        </Badge>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </TableShell>

          {total > PAGE_SIZE ? (
            <nav
              aria-label="Pagination"
              className="flex items-center justify-between gap-4 text-xs"
            >
              <p className="x-tabular text-ink-muted">
                {(page - 1) * PAGE_SIZE + 1}–{Math.min(total, page * PAGE_SIZE)} of {total}
              </p>
              <div className="flex gap-2">
                {page > 1 ? <PageLink params={params} page={page - 1} label="Previous" /> : null}
                {page * PAGE_SIZE < total ? (
                  <PageLink params={params} page={page + 1} label="Next" />
                ) : null}
              </div>
            </nav>
          ) : null}
        </>
      )}
    </ControlPage>
  );
}

/** Preserves the current filter when paging. */
function PageLink({
  params,
  page,
  label,
}: {
  params: Record<string, string | string[] | undefined>;
  page: number;
  label: string;
}): React.ReactElement {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.length > 0 && key !== 'page') query.set(key, value);
  }
  query.set('page', String(page));

  return (
    <Link
      href={`/control/applications?${query.toString()}`}
      className="rounded-sm border border-line-strong px-3 py-1.5 text-ink-secondary transition-colors hover:bg-elevated"
    >
      {label}
    </Link>
  );
}
