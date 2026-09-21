import Link from 'next/link';
import { notFound } from 'next/navigation';

import { statusLabels, statusTones } from '@xenon/applications';
import { normalisePublicId } from '@xenon/core';
import { prisma } from '@xenon/database';
import { entityHistory } from '@xenon/domain';
import { Avatar, Badge, Panel } from '@xenon/ui';

import { ControlPage } from '~/components/control/control-page';
import { PlayerActions } from '~/components/control/player-actions';
import { currentActor, requireCapability } from '~/server/context';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Player' };

/**
 * /control/players/[id]
 *
 * Everything about one account in one place, because a moderator deciding what
 * to do needs the history and not just the row: applications, characters,
 * tickets, appeals, linked identifiers and the audit trail.
 */
export default async function PlayerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  await requireCapability('players.view');
  const actor = await currentActor();

  const publicId = normalisePublicId(id, null) ?? id;

  const user = await prisma.user.findFirst({
    where: { OR: [{ publicId }, { id }] },
    include: {
      discordAccount: true,
      whitelist: true,
      gameIdentities: { where: { unlinkedAt: null } },
      roles: { include: { role: true } },
      characters: { orderBy: { createdAt: 'desc' } },
      submissions: {
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { template: { select: { name: true } } },
      },
      ticketsOpened: { orderBy: { createdAt: 'desc' }, take: 5 },
      appeals: { orderBy: { createdAt: 'desc' }, take: 5 },
      ruleAcceptances: {
        orderBy: { acceptedAt: 'desc' },
        take: 1,
        include: { ruleSet: { select: { version: true, isCurrent: true } } },
      },
    },
  });

  if (user === null) notFound();

  const [history, roles] = await Promise.all([
    actor.permissions.has('audit.view')
      ? entityHistory(prisma, 'user', user.id)
      : Promise.resolve([]),
    prisma.role.findMany({ orderBy: { priority: 'desc' } }),
  ]);

  const accountAgeDays = Math.floor((Date.now() - user.createdAt.getTime()) / 86_400_000);

  return (
    <ControlPage
      title={user.displayName ?? user.publicId}
      lead={`${user.publicId} · joined ${user.createdAt.toLocaleDateString('en-GB')} · ${String(accountAgeDays)} days old`}
      breadcrumb={{ href: '/control/players', label: 'Players' }}
      actions={
        <>
          <Badge tone={user.whitelistState === 'APPROVED' ? 'success' : 'neutral'}>
            {user.whitelistState.toLowerCase()}
          </Badge>
          <Badge
            tone={
              user.status === 'BANNED'
                ? 'danger'
                : user.status === 'SUSPENDED'
                  ? 'warning'
                  : 'neutral'
            }
          >
            {user.status.toLowerCase()}
          </Badge>
        </>
      }
    >
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <Panel tone="flat" pad="lg" className="flex flex-col gap-5">
            <div className="flex items-center gap-4">
              <Avatar src={user.avatarUrl} name={user.displayName} size={56} />
              <div className="flex min-w-0 flex-col gap-1">
                <p className="font-display text-lg font-bold text-ink">
                  {user.displayName ?? 'No display name'}
                </p>
                <p className="font-mono text-xs text-ink-muted">{user.publicId}</p>
              </div>
            </div>

            <dl className="grid gap-3 text-xs sm:grid-cols-2">
              <Row label="Discord" value={user.discordAccount?.username ?? 'not linked'} />
              <Row label="Discord ID" value={user.discordAccount?.discordId ?? '—'} mono />
              <Row
                label="In guild"
                value={user.discordAccount?.isGuildMember === true ? 'yes' : 'no'}
              />
              <Row label="Pronouns" value={user.pronouns ?? '—'} />
              <Row label="Timezone" value={user.timezone ?? '—'} />
              <Row
                label="Rules accepted"
                value={
                  user.ruleAcceptances[0] === undefined
                    ? 'never'
                    : `v${String(user.ruleAcceptances[0].ruleSet.version)}${
                        user.ruleAcceptances[0].ruleSet.isCurrent ? ' (current)' : ' (outdated)'
                      }`
                }
              />
              <Row label="Last seen" value={user.lastSeenAt?.toLocaleString('en-GB') ?? 'never'} />
              <Row
                label="Onboarding"
                value={user.onboardingStep.toLowerCase().replace(/_/g, ' ')}
              />
            </dl>
          </Panel>

          <Section title="Game identifiers">
            {user.gameIdentities.length === 0 ? (
              <Empty>No FiveM identifiers are linked.</Empty>
            ) : (
              <Panel tone="flat" pad="none" className="divide-y divide-line">
                {user.gameIdentities.map((identity) => (
                  <div key={identity.id} className="flex items-center justify-between gap-3 p-3.5">
                    <span className="text-xs text-ink">{identity.kind}</span>
                    <code className="min-w-0 flex-1 truncate text-right font-mono text-[0.625rem] text-ink-muted">
                      {identity.value}
                    </code>
                    {identity.isPrimary ? <Badge tone="success">Primary</Badge> : null}
                  </div>
                ))}
              </Panel>
            )}
          </Section>

          <Section title="Applications">
            {user.submissions.length === 0 ? (
              <Empty>No applications.</Empty>
            ) : (
              <Panel tone="flat" pad="none" className="divide-y divide-line">
                {user.submissions.map((submission) => (
                  <Link
                    key={submission.id}
                    href={`/control/applications/${submission.publicId}`}
                    className="flex items-center justify-between gap-3 p-3.5 text-xs transition-colors hover:bg-elevated"
                  >
                    <span className="font-mono text-ink-muted">{submission.publicId}</span>
                    <span className="min-w-0 flex-1 truncate text-ink-secondary">
                      {submission.template.name}
                    </span>
                    <Badge tone={statusTones[submission.status]}>
                      {statusLabels[submission.status]}
                    </Badge>
                  </Link>
                ))}
              </Panel>
            )}
          </Section>

          <Section title="Characters">
            {user.characters.length === 0 ? (
              <Empty>No characters.</Empty>
            ) : (
              <Panel tone="flat" pad="none" className="divide-y divide-line">
                {user.characters.map((character) => (
                  <div key={character.id} className="flex items-center justify-between gap-3 p-3.5">
                    <span className="text-xs text-ink">
                      {character.firstName} {character.lastName}
                      {character.alias === null ? null : (
                        <span className="text-ink-muted"> &ldquo;{character.alias}&rdquo;</span>
                      )}
                    </span>
                    <span className="font-mono text-[0.625rem] text-ink-muted">
                      {character.publicId}
                    </span>
                    <Badge tone={character.status === 'ACTIVE' ? 'success' : 'neutral'}>
                      {character.status.toLowerCase()}
                    </Badge>
                  </div>
                ))}
              </Panel>
            )}
          </Section>

          {actor.permissions.has('audit.view') && history.length > 0 ? (
            <Section title="Audit">
              <Panel tone="flat" pad="none" className="divide-y divide-line">
                {[...history]
                  .reverse()
                  .slice(0, 12)
                  .map((entry) => (
                    <div
                      key={entry.id}
                      className="flex items-center justify-between gap-3 p-3 text-xs"
                    >
                      <span className="font-mono text-ink-secondary">{entry.action}</span>
                      <span className="font-mono text-[0.5625rem] tracking-[0.1em] text-ink-muted uppercase">
                        {entry.actorLabel ?? 'system'} ·{' '}
                        {entry.createdAt.toLocaleString('en-GB', {
                          day: '2-digit',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                  ))}
              </Panel>
            </Section>
          ) : null}
        </div>

        <aside className="flex flex-col gap-4">
          <PlayerActions
            userId={user.id}
            publicId={user.publicId}
            whitelistState={user.whitelistState}
            accountStatus={user.status}
            assignedRoleIds={user.roles.map((assignment) => assignment.roleId)}
            roles={roles.map((role) => ({
              id: role.id,
              name: role.name,
              key: role.key,
              priority: role.priority,
            }))}
            can={{
              whitelist: actor.permissions.has('players.whitelist'),
              ban: actor.permissions.has('players.ban'),
              staff: actor.permissions.has('staff.manage'),
            }}
          />

          {user.ticketsOpened.length === 0 ? null : (
            <Panel tone="flat" pad="lg">
              <p className="x-eyebrow">Recent tickets</p>
              <ul className="mt-3 flex flex-col gap-2">
                {user.ticketsOpened.map((ticket) => (
                  <li key={ticket.id}>
                    <Link
                      href={`/control/tickets/${ticket.publicId}`}
                      className="flex items-center justify-between gap-2 text-xs text-ink-secondary hover:text-xenon"
                    >
                      <span className="truncate">{ticket.subject}</span>
                      <span className="shrink-0 font-mono text-[0.5625rem] text-ink-muted">
                        {ticket.status.toLowerCase().replace(/_/g, ' ')}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          {user.appeals.length === 0 ? null : (
            <Panel tone="flat" pad="lg">
              <p className="x-eyebrow">Appeals</p>
              <ul className="mt-3 flex flex-col gap-2">
                {user.appeals.map((appeal) => (
                  <li
                    key={appeal.id}
                    className="flex items-center justify-between gap-2 text-xs text-ink-secondary"
                  >
                    <span className="truncate">{appeal.kind.toLowerCase().replace(/_/g, ' ')}</span>
                    <span className="shrink-0 font-mono text-[0.5625rem] text-ink-muted">
                      {appeal.status.toLowerCase()}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </aside>
      </div>
    </ControlPage>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="x-eyebrow">{title}</h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Panel tone="flat" pad="lg">
      <p className="text-xs text-ink-muted">{children}</p>
    </Panel>
  );
}

function Row({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="x-eyebrow">{label}</dt>
      <dd className={mono ? 'truncate font-mono text-ink-secondary' : 'text-ink-secondary'}>
        {value}
      </dd>
    </div>
  );
}
