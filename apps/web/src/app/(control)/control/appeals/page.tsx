import Link from 'next/link';

import { prisma } from '@xenon/database';
import { listAppeals } from '@xenon/domain';
import { EmptyState } from '@xenon/ui';

import { AppealRow } from '~/components/control/appeal-row';
import { ControlPage } from '~/components/control/control-page';
import { currentActor, requireCapability } from '~/server/context';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Appeals' };

/**
 * /control/appeals
 *
 * Open appeals first, because an appeal is somebody waiting to find out whether
 * they can come back.
 */
export default async function ControlAppealsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  await requireCapability('appeals.view');
  const actor = await currentActor();
  const params = await searchParams;

  const status = typeof params.status === 'string' ? params.status : undefined;

  const { items, total } = await listAppeals(prisma, {
    ...(status === undefined
      ? {}
      : {
          status: status as
            'SUBMITTED' | 'UNDER_REVIEW' | 'AWAITING_INFO' | 'ACCEPTED' | 'DENIED' | 'WITHDRAWN',
        }),
    take: 50,
  });

  const filters = [
    { key: undefined, label: 'All' },
    { key: 'SUBMITTED', label: 'New' },
    { key: 'UNDER_REVIEW', label: 'Under review' },
    { key: 'AWAITING_INFO', label: 'Awaiting info' },
    { key: 'ACCEPTED', label: 'Accepted' },
    { key: 'DENIED', label: 'Denied' },
  ] as const;

  return (
    <ControlPage title="Appeals" lead={`${String(total)} appeal${total === 1 ? '' : 's'}.`}>
      <div className="flex flex-wrap gap-2">
        {filters.map((filter) => (
          <Link
            key={filter.label}
            href={
              filter.key === undefined
                ? '/control/appeals'
                : `/control/appeals?status=${filter.key}`
            }
            className={
              status === filter.key
                ? 'rounded-sm border border-xenon/40 bg-xenon-deep/20 px-3 py-1.5 text-xs text-xenon'
                : 'rounded-sm border border-line-strong px-3 py-1.5 text-xs text-ink-muted transition-colors hover:text-ink-secondary'
            }
          >
            {filter.label}
          </Link>
        ))}
      </div>

      {items.length === 0 ? (
        <EmptyState title="No appeals" description="Nothing matches this filter." />
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((appeal) => (
            <AppealRow
              key={appeal.id}
              appeal={{
                id: appeal.id,
                publicId: appeal.publicId,
                kind: appeal.kind,
                status: appeal.status,
                statement: appeal.statement,
                sanctionRef: appeal.sanctionRef,
                decision: appeal.decision,
                createdAt: appeal.createdAt.toISOString(),
                authorName: appeal.author.displayName ?? appeal.author.publicId,
                authorPublicId: appeal.author.publicId,
                authorAvatar: appeal.author.avatarUrl,
              }}
              canManage={actor.permissions.has('appeals.manage')}
            />
          ))}
        </div>
      )}
    </ControlPage>
  );
}
