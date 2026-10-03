import Link from 'next/link';

import { prisma } from '@xenon/database';
import { queryAudit } from '@xenon/domain';
import { Badge, EmptyState, Panel, TBody, TD, TH, THead, Table, TableShell, TR } from '@xenon/ui';

import { AuditFilters } from '~/components/control/audit-filters';
import { ControlPage } from '~/components/control/control-page';
import { requireCapability } from '~/server/context';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Audit log' };

const PAGE_SIZE = 50;

const sourceTone = {
  WEB: 'neutral',
  DISCORD: 'info',
  FIVEM: 'warning',
  SYSTEM: 'chrome',
  CLI: 'progress',
} as const;

/**
 * /control/system/audit
 *
 * Append-only by construction: there is no update path in the service layer and
 * none here. Every consequential mutation writes a row inside the same
 * transaction as the change, so a decision without an entry is impossible
 * rather than unlikely.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  await requireCapability('audit.view');
  const params = await searchParams;

  const single = (key: string): string | undefined => {
    const value = params[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };

  const page = Math.max(1, Number(single('page') ?? '1'));

  const { items, total } = await queryAudit(prisma, {
    ...(single('action') === undefined ? {} : { action: single('action') }),
    ...(single('entityType') === undefined ? {} : { entityType: single('entityType') }),
    ...(single('entityId') === undefined ? {} : { entityId: single('entityId') }),
    ...(single('q') === undefined ? {} : { search: single('q') }),
    ...(single('from') === undefined
      ? {}
      : { from: new Date(`${single('from') ?? ''}T00:00:00Z`) }),
    ...(single('to') === undefined ? {} : { to: new Date(`${single('to') ?? ''}T23:59:59Z`) }),
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
  });

  return (
    <ControlPage
      title="Audit log"
      lead={`${String(total)} record${total === 1 ? '' : 's'}. Append-only; nothing here can be edited or deleted from the interface.`}
    >
      <AuditFilters />

      {items.length === 0 ? (
        <EmptyState title="Nothing recorded" description="No audit entries match this filter." />
      ) : (
        <TableShell>
          <Table>
            <THead>
              <TH width="11rem">When</TH>
              <TH width="14rem">Action</TH>
              <TH width="12rem">Actor</TH>
              <TH width="6rem">Source</TH>
              <TH>Entity</TH>
            </THead>
            <TBody>
              {items.map((entry) => (
                <TR key={entry.id}>
                  <TD className="x-tabular whitespace-nowrap">
                    {entry.createdAt.toLocaleString('en-GB', {
                      day: '2-digit',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </TD>
                  <TD>
                    <code className="font-mono text-[0.6875rem] text-ink">{entry.action}</code>
                  </TD>
                  <TD>
                    {entry.actor === null ? (
                      // The label survives account deletion; the link does not.
                      <span className="text-ink-muted">{entry.actorLabel ?? 'system'}</span>
                    ) : (
                      <Link
                        href={`/control/players/${entry.actor.publicId}`}
                        className="hover:text-xenon"
                      >
                        {entry.actorLabel ?? entry.actor.publicId}
                      </Link>
                    )}
                  </TD>
                  <TD>
                    <Badge tone={sourceTone[entry.source]}>{entry.source.toLowerCase()}</Badge>
                  </TD>
                  <TD>
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-[0.625rem] text-ink-muted">
                        {entry.entityType}
                      </span>
                      {entry.entityLabel === null ? null : (
                        <span className="font-mono text-[0.6875rem] text-ink-secondary">
                          {entry.entityLabel}
                        </span>
                      )}
                    </span>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableShell>
      )}

      {total > PAGE_SIZE ? (
        <nav aria-label="Pagination" className="flex items-center justify-between gap-4 text-xs">
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

      <Panel tone="ghost" pad="md">
        <p className="text-[0.6875rem] leading-relaxed text-ink-muted">
          Before and after projections are stored alongside each entry and are scrubbed of tokens,
          secrets and hashes before they are written. Addresses are recorded as a peppered hash,
          never in plaintext.
        </p>
      </Panel>
    </ControlPage>
  );
}

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
      href={`/control/audit?${query.toString()}`}
      className="rounded-sm border border-line-strong px-3 py-1.5 text-ink-secondary transition-colors hover:bg-elevated"
    >
      {label}
    </Link>
  );
}
