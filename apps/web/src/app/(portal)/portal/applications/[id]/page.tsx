import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';

import { getSubmissionView, listComments, statusLabels, statusTones } from '@xenon/applications';
import { prisma } from '@xenon/database';
import { Badge, Panel } from '@xenon/ui';

import type { Metadata } from 'next';

import { ApplicationForm } from '~/components/applications/application-form';
import { ApplicationTimeline } from '~/components/applications/timeline';
import { PortalPage, PortalSection } from '~/components/portal/portal-page';
import { currentActor, requireUserId } from '~/server/context';
import { loadOrStatus } from '~/server/load';

export const metadata: Metadata = {
  title: 'Application',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * /portal/applications/[id]
 *
 * The applicant's view of one application: the form while it is editable, the
 * answers read-only once it is not, and the timeline either way.
 *
 * Authorization lives in `getSubmissionView`, which refuses anything that is
 * not the actor's own submission unless they hold `applications.view`. This
 * page does not re-implement that check; it would be a second place to get it
 * wrong.
 */
export default async function ApplicationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  const [actor, userId] = await Promise.all([currentActor(), requireUserId()]);

  const view = await loadOrStatus(getSubmissionView(prisma, actor, id));
  const { submission } = view;

  const [comments, characters] = await Promise.all([
    listComments(prisma, submission.id, false),
    prisma.character.findMany({
      where: { userId, status: 'ACTIVE' },
      select: { id: true, firstName: true, lastName: true, alias: true },
    }),
  ]);

  return (
    <PortalPage
      title={submission.template.name}
      lead={`${submission.publicId} · attempt ${String(submission.attempt)}`}
      actions={
        <Badge tone={statusTones[submission.status]}>{statusLabels[submission.status]}</Badge>
      }
    >
      <Link
        href="/portal/applications"
        className="inline-flex items-center gap-2 font-mono text-[0.6875rem] tracking-[0.16em] text-ink-muted uppercase transition-colors hover:text-xenon"
      >
        <ArrowLeft className="size-3.5" /> All applications
      </Link>

      <div className="grid gap-10 lg:grid-cols-[1fr_17rem] lg:gap-12">
        <div className="min-w-0">
          <ApplicationForm
            submissionId={submission.id}
            publicId={submission.publicId}
            templateName={submission.template.name}
            sections={view.sections}
            initialAnswers={{ ...view.answers }}
            initialRevision={submission.revision}
            editable={view.editable}
            decisionNote={
              submission.status === 'CHANGES_REQUESTED' ? submission.decisionNote : null
            }
            characters={characters.map((character) => ({
              id: character.id,
              label:
                character.alias === null
                  ? `${character.firstName} ${character.lastName}`
                  : `${character.firstName} "${character.alias}" ${character.lastName}`,
            }))}
          />
        </div>

        <aside className="flex flex-col gap-6 lg:sticky lg:top-6 lg:self-start">
          <PortalSection title="Timeline">
            <ApplicationTimeline
              entries={submission.events.map((event) => ({
                id: event.id,
                type: event.type,
                createdAt: event.createdAt,
                actorLabel: event.actor?.displayName ?? null,
                source: event.source,
              }))}
            />
          </PortalSection>

          {comments.length === 0 ? null : (
            <PortalSection title="Notes from staff">
              <div className="flex flex-col gap-3">
                {comments.map((comment) => (
                  <Panel key={comment.id} tone="flat" pad="md">
                    <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink-secondary">
                      {comment.body}
                    </p>
                    <p className="mt-2.5 font-mono text-[0.625rem] tracking-[0.12em] text-ink-muted uppercase">
                      {comment.author.displayName ?? 'Staff'} ·{' '}
                      {comment.createdAt.toLocaleDateString('en-GB')}
                    </p>
                  </Panel>
                ))}
              </div>
            </PortalSection>
          )}

          {submission.status === 'APPROVED' || submission.status === 'REJECTED' ? (
            submission.decisionNote === null ? null : (
              <PortalSection title="Decision">
                <Panel
                  tone="flat"
                  pad="md"
                  className={
                    submission.status === 'APPROVED'
                      ? 'border-xenon/30 bg-xenon-deep/10'
                      : 'border-danger/30 bg-danger/5'
                  }
                >
                  <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink-secondary">
                    {submission.decisionNote}
                  </p>
                </Panel>
              </PortalSection>
            )
          ) : null}
        </aside>
      </div>
    </PortalPage>
  );
}
