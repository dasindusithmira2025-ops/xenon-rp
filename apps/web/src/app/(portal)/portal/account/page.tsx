import { serverEnv } from '@xenon/config/server';
import { prisma } from '@xenon/database';
import { allSettings, onboardingState } from '@xenon/domain';
import { CFX_ATTEMPT_TTL_MS, cfxConnection, pendingCfxLink } from '@xenon/fivem';
import { Badge, Panel } from '@xenon/ui';

import type { Metadata } from 'next';

import { CfxConnectionPanel } from '~/components/portal/cfx-connection-panel';
import { CfxStatusBanner, parseCfxStatus } from '~/components/portal/cfx-status-banner';
import { DiscordMembership } from '~/components/portal/discord-membership';
import { PortalPage, PortalSection } from '~/components/portal/portal-page';
import { ProfileForm } from '~/components/portal/profile-form';
import { UNLINK_PHRASE } from '~/server/cfx';
import { requireUserId } from '~/server/context';
import { resolveDiscordInviteUrl } from '~/server/site';

export const metadata: Metadata = {
  title: 'Your account',
  robots: { index: false, follow: false },
};

// Rendered per request: the page is where every Cfx.re route lands, and the
// connection and onboarding state must reflect the link the moment it exists.
export const dynamic = 'force-dynamic';

/**
 * /portal/account
 *
 * Identity, profile and connections. Discord and Cfx.re are separate blocks
 * because they are separate credentials: Discord is how you sign in and is
 * read-only on purpose ("disconnect" would leave an account with no way in);
 * Cfx.re is the verified game account that admits you to the city.
 */
export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const userId = await requireUserId();
  const status = parseCfxStatus((await searchParams).cfx);

  const [user, onboarding, settings, cfx, pendingUntil] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        publicId: true,
        displayName: true,
        pronouns: true,
        timezone: true,
        bio: true,
        createdAt: true,
        whitelistState: true,
        discordAccount: {
          select: {
            username: true,
            globalName: true,
            discordId: true,
            guildMembershipState: true,
            guildSyncedAt: true,
            guildSyncError: true,
          },
        },
        gameIdentities: {
          where: { unlinkedAt: null, kind: { not: 'FIVEM' } },
          orderBy: { linkedAt: 'desc' },
        },
        ruleAcceptances: {
          orderBy: { acceptedAt: 'desc' },
          take: 3,
          include: { ruleSet: { select: { version: true, isCurrent: true } } },
        },
        sessions: { orderBy: { createdAt: 'desc' }, take: 5 },
      },
    }),
    onboardingState(prisma, userId),
    allSettings(prisma),
    cfxConnection(prisma, userId),
    pendingCfxLink(prisma, userId),
  ]);

  const invite = resolveDiscordInviteUrl(settings['community.discordInvite']);

  return (
    <PortalPage
      title="Your account"
      lead={`Xenon ID ${user.publicId}. This is the account everything else hangs off.`}
    >
      {status === null ? null : <CfxStatusBanner status={status} next={onboarding.next} />}

      <PortalSection title="Profile" description="How staff and other players see you.">
        <Panel tone="flat" pad="lg">
          <ProfileForm
            initial={{
              displayName: user.displayName ?? '',
              pronouns: user.pronouns ?? '',
              timezone: user.timezone ?? '',
              bio: user.bio ?? '',
            }}
          />
        </Panel>
      </PortalSection>

      <PortalSection title="Discord" description="How you sign in, and your community membership.">
        <Panel tone="flat" pad="lg" className="flex flex-col gap-4">
          {user.discordAccount === null ? (
            <p className="text-sm text-ink-muted">No Discord account is linked.</p>
          ) : (
            <>
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <Detail label="Username" value={user.discordAccount.username} />
                <Detail
                  label="Display name"
                  value={user.discordAccount.globalName ?? user.discordAccount.username}
                />
                <Detail label="Discord ID" value={user.discordAccount.discordId} mono />
                <div className="flex flex-col gap-2 sm:col-span-2">
                  <dt className="x-eyebrow">Xenon community</dt>
                  <dd>
                    <DiscordMembership
                      state={user.discordAccount.guildMembershipState}
                      syncedAt={user.discordAccount.guildSyncedAt?.toISOString() ?? null}
                      error={user.discordAccount.guildSyncError}
                      invite={invite}
                      enabled={serverEnv.DISCORD_MODE === 'enabled'}
                    />
                  </dd>
                </div>
              </dl>
            </>
          )}
        </Panel>
      </PortalSection>

      <div id="fivem" className="scroll-mt-6">
        <PortalSection
          title="Cfx.re"
          description="Your verified FiveM account. The city admits you by it once you are whitelisted."
        >
          <CfxConnectionPanel
            connection={{
              linked: cfx.linked,
              username: cfx.username,
              cfxUserId: cfx.cfxUserId,
              linkedAt: cfx.linkedAt?.toISOString() ?? null,
            }}
            pendingExpiresAt={pendingUntil?.toISOString() ?? null}
            attemptWindowSeconds={CFX_ATTEMPT_TTL_MS / 1000}
            legacyIdentities={user.gameIdentities.map((identity) => ({
              id: identity.id,
              kind: identity.kind,
              value: identity.value,
              linkedAt: identity.linkedAt.toISOString(),
              isPrimary: identity.isPrimary,
            }))}
            unlinkPhrase={UNLINK_PHRASE}
          />
        </PortalSection>
      </div>

      <PortalSection title="Rules" description="Which version of the rulebook you accepted.">
        <Panel tone="flat" pad="lg">
          {user.ruleAcceptances.length === 0 ? (
            <p className="text-sm text-ink-muted">You have not accepted a ruleset yet.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {user.ruleAcceptances.map((acceptance) => (
                <li key={acceptance.id} className="flex items-center justify-between gap-4 text-sm">
                  <span className="text-ink-secondary">
                    Version {String(acceptance.ruleSet.version)}
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="font-mono text-[0.625rem] tracking-[0.12em] text-ink-muted uppercase">
                      {acceptance.acceptedAt.toLocaleDateString('en-GB')}
                    </span>
                    {acceptance.ruleSet.isCurrent ? <Badge tone="success">Current</Badge> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {onboarding.checks.rulesAccepted ? null : (
            <p className="mt-4 text-sm text-warning">
              You have not accepted the current ruleset. You can do that from your portal overview.
            </p>
          )}
        </Panel>
      </PortalSection>

      <PortalSection
        title="Sessions"
        description="Where you are signed in. Signing out ends the current session immediately."
      >
        <Panel tone="flat" pad="none" className="divide-y divide-line">
          {user.sessions.map((session) => (
            <div key={session.id} className="flex items-center justify-between gap-4 p-4 text-xs">
              <span className="truncate text-ink-secondary">
                {session.userAgent ?? 'Unknown device'}
              </span>
              <span className="shrink-0 font-mono text-[0.625rem] tracking-[0.12em] text-ink-muted uppercase">
                {session.createdAt.toLocaleDateString('en-GB')}
              </span>
            </div>
          ))}
        </Panel>
      </PortalSection>
    </PortalPage>
  );
}

function Detail({
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
      <dd className={mono ? 'font-mono text-xs text-ink-secondary' : 'text-ink-secondary'}>
        {value}
      </dd>
    </div>
  );
}
