import { ArrowRight, Gamepad2, ShieldCheck, Users } from 'lucide-react';
import Link from 'next/link';

import { statusLabels, statusTones } from '@xenon/applications';
import { prisma } from '@xenon/database';
import { allSettings, currentRuleSet, onboardingState, statusBoard } from '@xenon/domain';
import { Badge, Button, EmptyState, Panel, StatusDot } from '@xenon/ui';

import type { Metadata } from 'next';

import { Onboarding } from '~/components/portal/onboarding';
import { PortalPage, PortalSection } from '~/components/portal/portal-page';
import { requireUserId } from '~/server/context';

export const metadata: Metadata = {
  title: 'Portal',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * /portal
 *
 * The player's account, not an admin dashboard. It answers four questions in
 * order: what is my state, what do I need to do next, what is in flight, and
 * is the city up.
 */
export default async function PortalHome(): Promise<React.ReactElement> {
  const userId = await requireUserId();

  const [user, onboarding, board, settings, ruleSet, submissions, notifications] =
    await Promise.all([
      prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          publicId: true,
          displayName: true,
          whitelistState: true,
          createdAt: true,
          discordAccount: { select: { username: true, isGuildMember: true } },
          gameIdentities: {
            where: { unlinkedAt: null },
            select: { kind: true, value: true, label: true },
          },
          characters: {
            where: { status: 'ACTIVE' },
            select: { publicId: true, firstName: true, lastName: true, alias: true },
            take: 4,
          },
        },
      }),
      onboardingState(prisma, userId),
      statusBoard(prisma),
      allSettings(prisma),
      currentRuleSet(prisma),
      prisma.applicationSubmission.findMany({
        where: {
          applicantId: userId,
          status: { notIn: ['ARCHIVED', 'EXPIRED', 'WITHDRAWN'] },
        },
        orderBy: { updatedAt: 'desc' },
        take: 3,
        include: { template: { select: { name: true } } },
      }),
      prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 4,
      }),
    ]);

  const invite = settings['community.discordInvite'];
  const primary = board.servers[0];

  return (
    <PortalPage
      title={`Welcome back, ${user.displayName ?? 'player'}`}
      lead={`Xenon ID ${user.publicId} · joined ${user.createdAt.toLocaleDateString('en-GB', {
        month: 'long',
        year: 'numeric',
      })}`}
      actions={
        <Button variant="outline" asChild>
          <Link href="/applications">
            Applications <ArrowRight />
          </Link>
        </Button>
      }
    >
      <Onboarding
        state={onboarding}
        discordInvite={invite !== undefined && invite.length > 0 ? invite : null}
        ruleVersion={ruleSet?.version ?? null}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          icon={<ShieldCheck className="size-4" aria-hidden />}
          label="Whitelist"
          value={user.whitelistState === 'APPROVED' ? 'Approved' : 'Not yet'}
          tone={user.whitelistState === 'APPROVED' ? 'success' : 'neutral'}
          hint={
            user.whitelistState === 'APPROVED'
              ? 'You can connect to the city'
              : 'Apply to get access'
          }
        />
        <StatCard
          icon={<Gamepad2 className="size-4" aria-hidden />}
          label="Game account"
          value={user.gameIdentities.length > 0 ? 'Linked' : 'Not linked'}
          tone={user.gameIdentities.length > 0 ? 'success' : 'warning'}
          hint={
            user.gameIdentities.length > 0
              ? `${String(user.gameIdentities.length)} identifier${user.gameIdentities.length === 1 ? '' : 's'}`
              : 'Generate a link code'
          }
        />
        <StatCard
          icon={<Users className="size-4" aria-hidden />}
          label="Characters"
          value={String(user.characters.length)}
          tone="neutral"
          hint={user.characters.length === 0 ? 'Create your first' : 'active in the city'}
        />
      </div>

      <PortalSection
        title="In progress"
        description="Applications you have open right now."
        actions={
          <Button variant="ghost" size="sm" asChild>
            <Link href="/portal/applications">See all</Link>
          </Button>
        }
      >
        {submissions.length === 0 ? (
          <EmptyState
            title="Nothing in progress"
            description="When you start an application it appears here, saved as you type."
            action={
              <Button variant="accent" asChild>
                <Link href="/applications">Browse applications</Link>
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col gap-3">
            {submissions.map((submission) => (
              <Link
                key={submission.id}
                href={`/portal/applications/${submission.publicId}`}
                className="group flex items-center justify-between gap-4 rounded-lg border border-line bg-surface p-5 transition-colors hover:border-chrome-500"
              >
                <div className="flex min-w-0 flex-col gap-1.5">
                  <p className="font-medium text-ink transition-colors group-hover:text-xenon">
                    {submission.template.name}
                  </p>
                  <p className="font-mono text-[0.6875rem] tracking-[0.14em] text-ink-muted">
                    {submission.publicId}
                  </p>
                </div>
                <Badge tone={statusTones[submission.status]}>
                  {statusLabels[submission.status]}
                </Badge>
              </Link>
            ))}
          </div>
        )}
      </PortalSection>

      <div className="grid gap-4 lg:grid-cols-2">
        <PortalSection
          title="Recent notifications"
          actions={
            <Button variant="ghost" size="sm" asChild>
              <Link href="/portal/notifications">All</Link>
            </Button>
          }
        >
          {notifications.length === 0 ? (
            <Panel tone="flat" pad="lg">
              <p className="text-sm text-ink-muted">Nothing yet.</p>
            </Panel>
          ) : (
            <Panel tone="flat" pad="none" className="divide-y divide-line">
              {notifications.map((notification) => (
                <Link
                  key={notification.id}
                  href={notification.href ?? '/portal/notifications'}
                  className="flex flex-col gap-1 p-4 transition-colors hover:bg-elevated"
                >
                  <div className="flex items-center gap-2">
                    {notification.webReadAt === null ? (
                      <span
                        className="size-1.5 shrink-0 rounded-full bg-xenon"
                        aria-label="Unread"
                      />
                    ) : null}
                    <p className="truncate text-sm font-medium text-ink">{notification.title}</p>
                  </div>
                  <p className="line-clamp-2 text-xs leading-relaxed text-ink-muted">
                    {notification.body}
                  </p>
                </Link>
              ))}
            </Panel>
          )}
        </PortalSection>

        <PortalSection title="The city">
          <Panel tone="flat" pad="lg" className="flex flex-col gap-4">
            <div className="flex items-center gap-2.5">
              <StatusDot
                state={
                  board.aggregate === 'ONLINE'
                    ? 'online'
                    : board.aggregate === 'OFFLINE'
                      ? 'offline'
                      : board.aggregate === 'DEGRADED'
                        ? 'degraded'
                        : 'unknown'
                }
              />
              <span className="text-sm text-ink">
                {board.aggregate === 'ONLINE'
                  ? board.totalPlayers === null
                    ? 'Online'
                    : `${String(board.totalPlayers)} in the city`
                  : board.aggregate === 'OFFLINE'
                    ? 'Offline'
                    : board.aggregate === 'DEGRADED'
                      ? 'Partial service'
                      : 'Status unavailable'}
              </span>
            </div>

            <dl className="flex flex-col gap-2 text-xs">
              <div className="flex justify-between gap-4">
                <dt className="text-ink-muted">Next restart</dt>
                <dd className="x-tabular text-ink-secondary">
                  {primary?.nextRestartAt == null
                    ? 'not scheduled'
                    : `${new Date(primary.nextRestartAt).toLocaleTimeString('en-GB', {
                        hour: '2-digit',
                        minute: '2-digit',
                        timeZone: 'UTC',
                      })} UTC`}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-ink-muted">Discord</dt>
                <dd className="text-ink-secondary">
                  {user.discordAccount?.isGuildMember === true ? 'Member' : 'Not in the guild'}
                </dd>
              </div>
            </dl>

            <Button variant="outline" size="sm" asChild className="mt-auto">
              <Link href="/status">Full status</Link>
            </Button>
          </Panel>
        </PortalSection>
      </div>
    </PortalPage>
  );
}

function StatCard({
  icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint: string;
  tone: 'success' | 'warning' | 'neutral';
}): React.ReactElement {
  return (
    <Panel tone="flat" pad="lg" className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-ink-muted">
        {icon}
        <span className="x-eyebrow">{label}</span>
      </div>
      <p
        className={
          tone === 'success'
            ? 'font-display text-xl font-bold text-xenon'
            : tone === 'warning'
              ? 'font-display text-xl font-bold text-warning'
              : 'font-display text-xl font-bold text-ink'
        }
      >
        {value}
      </p>
      <p className="text-xs text-ink-muted">{hint}</p>
    </Panel>
  );
}
