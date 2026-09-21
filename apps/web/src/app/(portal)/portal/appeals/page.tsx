import Link from 'next/link';

import { prisma } from '@xenon/database';
import { listAppeals } from '@xenon/domain';
import { Badge, Button, EmptyState, Panel } from '@xenon/ui';

import type { Metadata } from 'next';

import { PortalPage } from '~/components/portal/portal-page';
import { requireUserId } from '~/server/context';

export const metadata: Metadata = {
  title: 'Appeals',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const appealTone = {
  SUBMITTED: 'info',
  UNDER_REVIEW: 'warning',
  AWAITING_INFO: 'attention',
  ACCEPTED: 'success',
  DENIED: 'danger',
  WITHDRAWN: 'neutral',
} as const;

/**
 * /portal/appeals
 *
 * Reachable by a sanctioned account on purpose. Everything else in the portal
 * is gated on standing; an appeal process a banned player cannot open is not an
 * appeal process.
 */
export default async function AppealsPage(): Promise<React.ReactElement> {
  const userId = await requireUserId();
  const { items } = await listAppeals(prisma, { authorId: userId, take: 25 });

  const hasOpen = items.some(
    (appeal) =>
      appeal.status === 'SUBMITTED' ||
      appeal.status === 'UNDER_REVIEW' ||
      appeal.status === 'AWAITING_INFO',
  );

  return (
    <PortalPage
      title="Appeals"
      lead="One appeal at a time. Decisions are made by someone other than whoever made the original call wherever that is possible."
      actions={
        hasOpen ? undefined : (
          <Button variant="accent" asChild>
            <Link href="/support">File an appeal</Link>
          </Button>
        )
      }
    >
      {items.length === 0 ? (
        <EmptyState
          title="No appeals"
          description="If a decision has gone against you and you think it is wrong, you can appeal it from the support page."
          action={
            <Button variant="outline" asChild>
              <Link href="/support">Open the support page</Link>
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          {items.map((appeal) => (
            <Panel key={appeal.id} tone="flat" pad="lg" className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-medium text-ink">
                    {appeal.kind.toLowerCase().replace(/_/g, ' ')}
                  </p>
                  <p className="mt-1 font-mono text-[0.6875rem] tracking-[0.14em] text-ink-muted">
                    {appeal.publicId} · {appeal.createdAt.toLocaleDateString('en-GB')}
                  </p>
                </div>
                <Badge tone={appealTone[appeal.status]}>
                  {appeal.status.toLowerCase().replace(/_/g, ' ')}
                </Badge>
              </div>

              <p className="line-clamp-4 text-sm leading-relaxed whitespace-pre-wrap text-ink-secondary">
                {appeal.statement}
              </p>

              {appeal.decision === null ? null : (
                <div
                  className={
                    appeal.status === 'ACCEPTED'
                      ? 'rounded-md border border-xenon/30 bg-xenon-deep/10 p-4'
                      : 'rounded-md border border-line-strong bg-black p-4'
                  }
                >
                  <p className="x-eyebrow">Staff decision</p>
                  <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-ink-secondary">
                    {appeal.decision}
                  </p>
                </div>
              )}
            </Panel>
          ))}
        </div>
      )}
    </PortalPage>
  );
}
