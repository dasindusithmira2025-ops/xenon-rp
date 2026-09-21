import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

import { statusLabels, statusTones, listOwnSubmissions } from '@xenon/applications';
import { prisma } from '@xenon/database';
import { Badge, Button, EmptyState } from '@xenon/ui';

import type { Metadata } from 'next';

import { PortalPage } from '~/components/portal/portal-page';
import { requireUserId } from '~/server/context';

export const metadata: Metadata = {
  title: 'Your applications',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function PortalApplicationsPage(): Promise<React.ReactElement> {
  const userId = await requireUserId();
  const submissions = await listOwnSubmissions(prisma, userId);

  const live = submissions.filter(
    (submission) =>
      submission.status !== 'APPROVED' &&
      submission.status !== 'REJECTED' &&
      submission.status !== 'WITHDRAWN' &&
      submission.status !== 'EXPIRED' &&
      submission.status !== 'ARCHIVED',
  );
  const past = submissions.filter((submission) => !live.includes(submission));

  return (
    <PortalPage
      title="Your applications"
      lead="Everything you have started, submitted or had decided."
      actions={
        <Button variant="accent" asChild>
          <Link href="/applications">
            New application <ArrowRight />
          </Link>
        </Button>
      }
    >
      {submissions.length === 0 ? (
        <EmptyState
          title="You have not applied yet"
          description="Whitelist and department applications both start from the applications page."
          action={
            <Button variant="accent" asChild>
              <Link href="/applications">Browse applications</Link>
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-10">
          {live.length > 0 ? (
            <section className="flex flex-col gap-3">
              <h2 className="x-eyebrow">In progress</h2>
              {live.map((submission) => (
                <SubmissionRow key={submission.id} submission={submission} />
              ))}
            </section>
          ) : null}

          {past.length > 0 ? (
            <section className="flex flex-col gap-3">
              <h2 className="x-eyebrow">Decided</h2>
              {past.map((submission) => (
                <SubmissionRow key={submission.id} submission={submission} muted />
              ))}
            </section>
          ) : null}
        </div>
      )}
    </PortalPage>
  );
}

type SubmissionListItem = Awaited<ReturnType<typeof listOwnSubmissions>>[number];

function SubmissionRow({
  submission,
  muted = false,
}: {
  submission: SubmissionListItem;
  muted?: boolean;
}): React.ReactElement {
  return (
    <Link
      href={`/portal/applications/${submission.publicId}`}
      className={
        muted
          ? 'group flex flex-wrap items-center justify-between gap-4 rounded-lg border border-line bg-surface p-5 opacity-70 transition-opacity hover:opacity-100'
          : 'group flex flex-wrap items-center justify-between gap-4 rounded-lg border border-line bg-surface p-5 transition-colors hover:border-chrome-500'
      }
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="font-medium text-ink transition-colors group-hover:text-xenon">
          {submission.template.name}
        </p>
        <p className="font-mono text-[0.6875rem] tracking-[0.14em] text-ink-muted">
          {submission.publicId}
          {submission.character === null ? null : (
            <>
              {' '}
              · {submission.character.firstName} {submission.character.lastName}
            </>
          )}
        </p>
      </div>

      <div className="flex items-center gap-4">
        <span className="hidden font-mono text-[0.625rem] tracking-[0.12em] text-ink-muted uppercase sm:inline">
          {submission.submittedAt === null
            ? `started ${submission.createdAt.toLocaleDateString('en-GB')}`
            : `submitted ${submission.submittedAt.toLocaleDateString('en-GB')}`}
        </span>
        <Badge tone={statusTones[submission.status]}>{statusLabels[submission.status]}</Badge>
      </div>
    </Link>
  );
}
