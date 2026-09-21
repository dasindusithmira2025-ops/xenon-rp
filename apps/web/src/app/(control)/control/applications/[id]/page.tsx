import { ExternalLink } from 'lucide-react';
import Link from 'next/link';

import {
  answerToText,
  getSubmissionView,
  listComments,
  statusLabels,
  statusTones,
} from '@xenon/applications';
import { prisma } from '@xenon/database';
import { entityHistory } from '@xenon/domain';
import { Avatar, Badge, Panel } from '@xenon/ui';

import { ApplicationTimeline } from '~/components/applications/timeline';
import { ControlPage } from '~/components/control/control-page';
import { ReviewActions } from '~/components/control/review-actions';
import { requireCapability } from '~/server/context';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Review' };

/**
 * /control/applications/[id]
 *
 * The review screen. Three columns on a desktop, because a reviewer needs three
 * things at once and tabbing between them is how inconsistent decisions happen:
 *
 *   left    who is this person, and what is their history
 *   centre  what did they actually write
 *   right   what am I going to do about it
 *
 * It collapses to a single column on narrow screens, ordered centre-first:
 * on a phone the answers are what you came to read.
 */
export default async function ReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  const actor = await requireCapability('applications.view');

  const view = await getSubmissionView(prisma, actor, id);
  const { submission } = view;

  const [comments, history, reviewers, previous] = await Promise.all([
    listComments(prisma, submission.id, true),
    entityHistory(prisma, 'application_submission', submission.id),
    // Anyone who can claim a review is a valid assignee.
    prisma.user.findMany({
      where: {
        deletedAt: null,
        roles: {
          some: {
            role: { permissions: { some: { permission: { key: 'applications.review' } } } },
          },
        },
      },
      select: { id: true, displayName: true, publicId: true },
      orderBy: { displayName: 'asc' },
    }),
    prisma.applicationSubmission.findMany({
      where: { applicantId: submission.applicantId, id: { not: submission.id } },
      orderBy: { createdAt: 'desc' },
      take: 6,
      include: { template: { select: { name: true } } },
    }),
  ]);

  const applicant = submission.applicant;
  const accountAgeDays = Math.floor((Date.now() - applicant.createdAt.getTime()) / 86_400_000);

  const [identities, whitelist] = await Promise.all([
    prisma.gameIdentity.findMany({
      where: { userId: submission.applicantId, unlinkedAt: null },
      select: { kind: true, value: true },
    }),
    prisma.whitelist.findUnique({ where: { userId: submission.applicantId } }),
  ]);

  return (
    <ControlPage
      title={submission.publicId}
      lead={`${submission.template.name} · attempt ${String(submission.attempt)}`}
      breadcrumb={{ href: '/control/applications', label: 'Review queue' }}
      actions={
        <Badge tone={statusTones[submission.status]}>{statusLabels[submission.status]}</Badge>
      }
    >
      <div className="grid gap-6 xl:grid-cols-[17rem_minmax(0,1fr)_20rem]">
        {/* --- Applicant ------------------------------------------------- */}
        <aside className="order-2 flex flex-col gap-4 xl:order-1">
          <Panel tone="flat" pad="lg" className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <Avatar src={applicant.avatarUrl} name={applicant.displayName} size={44} />
              <div className="flex min-w-0 flex-col">
                <p className="truncate font-medium text-ink">
                  {applicant.displayName ?? applicant.publicId}
                </p>
                <Link
                  href={`/control/players/${applicant.publicId}`}
                  className="font-mono text-[0.625rem] tracking-[0.12em] text-xenon hover:underline"
                >
                  {applicant.publicId}
                </Link>
              </div>
            </div>

            <dl className="flex flex-col gap-2 text-xs">
              <Row label="Account age" value={`${String(accountAgeDays)} days`} />
              <Row
                label="Discord"
                value={applicant.discordAccount?.username ?? 'not linked'}
                tone={applicant.discordAccount === null ? 'warn' : 'normal'}
              />
              <Row
                label="In guild"
                value={applicant.discordAccount?.isGuildMember === true ? 'yes' : 'no'}
                tone={applicant.discordAccount?.isGuildMember === true ? 'normal' : 'warn'}
              />
              <Row
                label="FiveM"
                value={
                  identities.length === 0
                    ? 'not linked'
                    : `${String(identities.length)} identifier${identities.length === 1 ? '' : 's'}`
                }
                tone={identities.length === 0 ? 'warn' : 'normal'}
              />
              <Row
                label="Whitelist"
                value={applicant.whitelistState.toLowerCase()}
                tone={applicant.whitelistState === 'APPROVED' ? 'good' : 'normal'}
              />
              {whitelist?.reason == null ? null : <Row label="Reason" value={whitelist.reason} />}
            </dl>
          </Panel>

          {submission.character === null ? null : (
            <Panel tone="flat" pad="lg">
              <p className="x-eyebrow">Character</p>
              <p className="mt-2 text-sm text-ink">
                {submission.character.firstName} {submission.character.lastName}
              </p>
              {submission.character.backstory === null ? null : (
                <p className="mt-2 line-clamp-6 text-xs leading-relaxed text-ink-muted">
                  {submission.character.backstory}
                </p>
              )}
            </Panel>
          )}

          <Panel tone="flat" pad="lg">
            <p className="x-eyebrow">Previous applications</p>
            {previous.length === 0 ? (
              <p className="mt-2 text-xs text-ink-muted">This is their first.</p>
            ) : (
              <ul className="mt-3 flex flex-col gap-2">
                {previous.map((entry) => (
                  <li key={entry.id} className="flex items-center justify-between gap-2 text-xs">
                    <Link
                      href={`/control/applications/${entry.publicId}`}
                      className="truncate text-ink-secondary hover:text-xenon"
                    >
                      {entry.template.name}
                    </Link>
                    <Badge tone={statusTones[entry.status]}>{statusLabels[entry.status]}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </aside>

        {/* --- Answers ----------------------------------------------------- */}
        <div className="order-1 flex min-w-0 flex-col gap-6 xl:order-2">
          {submission.status === 'CHANGES_REQUESTED' && submission.decisionNote !== null ? (
            <Panel tone="ghost" pad="lg" className="border-warning/30 bg-warning/5">
              <p className="x-eyebrow text-warning">Changes requested</p>
              <p className="mt-2 text-sm whitespace-pre-wrap text-ink-secondary">
                {submission.decisionNote}
              </p>
            </Panel>
          ) : null}

          {view.sections.map((section) => (
            <section key={section.id} className="flex flex-col gap-4">
              <div className="border-b border-line pb-2">
                <h2 className="font-display text-sm font-bold tracking-wide text-ink uppercase">
                  {section.title}
                </h2>
              </div>

              <dl className="flex flex-col gap-5">
                {section.questions.map((question) => {
                  const rendered = answerToText(question, view.answers[question.key]);
                  return (
                    <div key={question.key} className="flex flex-col gap-1.5">
                      <dt className="flex items-center gap-2 text-xs text-ink-muted">
                        {question.label}
                        {question.staffOnly ? <Badge tone="chrome">Staff only</Badge> : null}
                      </dt>
                      <dd
                        className={
                          rendered === null
                            ? 'text-sm text-ink-muted italic'
                            : 'rounded-md border border-line bg-black p-3.5 text-sm leading-relaxed whitespace-pre-wrap text-ink-secondary'
                        }
                      >
                        {rendered ?? 'No answer'}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </section>
          ))}

          {comments.length === 0 ? null : (
            <section className="flex flex-col gap-3">
              <h2 className="x-eyebrow">Notes</h2>
              {comments.map((comment) => (
                <Panel
                  key={comment.id}
                  tone="flat"
                  pad="md"
                  className={comment.visibility === 'APPLICANT' ? 'border-l-2 border-l-xenon' : ''}
                >
                  <div className="flex items-center gap-2">
                    <Avatar
                      src={comment.author.avatarUrl}
                      name={comment.author.displayName}
                      size={20}
                    />
                    <span className="text-xs text-ink">
                      {comment.author.displayName ?? comment.author.publicId}
                    </span>
                    <Badge tone={comment.visibility === 'APPLICANT' ? 'success' : 'neutral'}>
                      {comment.visibility === 'APPLICANT' ? 'Applicant sees this' : 'Internal'}
                    </Badge>
                    <time className="ml-auto font-mono text-[0.625rem] text-ink-muted">
                      {comment.createdAt.toLocaleString('en-GB', {
                        day: '2-digit',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                  </div>
                  <p className="mt-2 text-sm whitespace-pre-wrap text-ink-secondary">
                    {comment.body}
                  </p>
                </Panel>
              ))}
            </section>
          )}
        </div>

        {/* --- Decision ---------------------------------------------------- */}
        <aside className="order-3 flex flex-col gap-4">
          <ReviewActions
            reference={submission.publicId}
            status={submission.status}
            viewerId={actor.userId ?? ''}
            assignee={
              submission.assignee === null
                ? null
                : {
                    id: submission.assignee.id,
                    name: submission.assignee.displayName ?? submission.assignee.publicId,
                  }
            }
            reviewers={reviewers.map((reviewer) => ({
              id: reviewer.id,
              name: reviewer.displayName ?? reviewer.publicId,
            }))}
            can={{
              review: actor.permissions.has('applications.review'),
              assign: actor.permissions.has('applications.assign'),
              approve: actor.permissions.has('applications.approve'),
              reject: actor.permissions.has('applications.reject'),
              requestChanges: actor.permissions.has('applications.request_changes'),
              interview: actor.permissions.has('applications.interview'),
            }}
            grantsWhitelist={submission.template.grantsWhitelist}
            grantRoleKeys={submission.template.grantRoleKeys}
          />

          <Panel tone="flat" pad="lg">
            <p className="x-eyebrow">Timeline</p>
            <div className="mt-4">
              <ApplicationTimeline
                showInternal
                entries={submission.events.map((event) => ({
                  id: event.id,
                  type: event.type,
                  createdAt: event.createdAt,
                  actorLabel: event.actor?.displayName ?? null,
                  source: event.source,
                }))}
              />
            </div>
          </Panel>

          {actor.permissions.has('audit.view') ? (
            <Panel tone="flat" pad="lg">
              <p className="x-eyebrow flex items-center justify-between">
                Audit
                <Link
                  href={`/control/audit?entityType=application_submission&entityId=${submission.id}`}
                  className="text-ink-muted transition-colors hover:text-xenon"
                >
                  <ExternalLink className="size-3" />
                </Link>
              </p>
              <ul className="mt-3 flex flex-col gap-2">
                {history.slice(-6).map((entry) => (
                  <li key={entry.id} className="flex flex-col gap-0.5 text-xs">
                    <span className="font-mono text-[0.625rem] text-ink-secondary">
                      {entry.action}
                    </span>
                    <span className="font-mono text-[0.5625rem] tracking-[0.1em] text-ink-muted uppercase">
                      {entry.actorLabel ?? 'system'} ·{' '}
                      {entry.createdAt.toLocaleString('en-GB', {
                        day: '2-digit',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
        </aside>
      </div>
    </ControlPage>
  );
}

function Row({
  label,
  value,
  tone = 'normal',
}: {
  label: string;
  value: string;
  tone?: 'normal' | 'warn' | 'good';
}): React.ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd
        className={
          tone === 'warn' ? 'text-warning' : tone === 'good' ? 'text-xenon' : 'text-ink-secondary'
        }
      >
        {value}
      </dd>
    </div>
  );
}
