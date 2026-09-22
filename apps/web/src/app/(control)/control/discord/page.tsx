import { discordCallbackUrl, serverEnv } from '@xenon/config/server';
import { prisma } from '@xenon/database';
import { Badge, Panel } from '@xenon/ui';

import { ControlPage } from '~/components/control/control-page';
import { DiscordConfig } from '~/components/control/discord-config';
import { requireCapability } from '~/server/context';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Discord' };

/**
 * /control/integrations/discord
 *
 * The guild, the channels and the role mappings. Nothing here is a secret: the
 * bot token lives in the environment and is never read by the web tier at all.
 */
export default async function DiscordPage(): Promise<React.ReactElement> {
  await requireCapability('discord.manage');

  const [guild, roles, heartbeat] = await Promise.all([
    prisma.discordGuild.findFirst({
      where: { isPrimary: true },
      include: { roleMappings: { include: { role: true } } },
    }),
    prisma.role.findMany({ orderBy: { priority: 'desc' } }),
    prisma.serviceHeartbeat.findUnique({ where: { service: 'bot' } }),
  ]);

  const heartbeatFresh = heartbeat !== null && Date.now() - heartbeat.beatAt.getTime() < 90_000;
  const discordDisabled = serverEnv.DISCORD_MODE === 'disabled';
  const botOnline = !discordDisabled && heartbeatFresh && heartbeat.status === 'HEALTHY';
  const heartbeatDetail = heartbeat?.detail;
  const botDetail =
    heartbeatDetail !== null &&
    typeof heartbeatDetail === 'object' &&
    !Array.isArray(heartbeatDetail)
      ? (heartbeatDetail as Record<string, unknown>)
      : {};
  const oauthConfigured =
    serverEnv.DISCORD_MODE === 'enabled' &&
    serverEnv.AUTH_DISCORD_ID !== undefined &&
    serverEnv.AUTH_DISCORD_SECRET !== undefined;
  const configuredGuildMatches = guild !== null && guild.guildId === serverEnv.DISCORD_GUILD_ID;

  return (
    <ControlPage
      title="Discord"
      lead="Xenon owns role membership; Discord mirrors it. Nothing here grants a permission - it decides which Discord role reflects a Xenon role."
      actions={
        <Badge tone={botOnline ? 'success' : 'warning'}>
          {discordDisabled
            ? 'Discord disabled'
            : botOnline
              ? 'Bot ready'
              : heartbeatFresh
                ? 'Bot degraded'
                : 'Bot offline'}
        </Badge>
      }
    >
      {discordDisabled ? (
        <Panel tone="ghost" pad="md" className="border-warning/30 bg-warning/5">
          <p className="text-xs leading-relaxed text-warning">
            Discord is explicitly disabled in this environment. OAuth, membership checks and bot
            actions are unavailable until the rotated Xenon application credentials are configured.
          </p>
        </Panel>
      ) : !heartbeatFresh ? (
        <Panel tone="ghost" pad="md" className="border-warning/30 bg-warning/5">
          <p className="text-xs leading-relaxed text-warning">
            The bot has not sent a heartbeat recently. Role synchronisation, review cards and direct
            messages are queued and will be delivered when it comes back - nothing is lost. Start it
            with <code className="font-mono">pnpm --filter @xenon/bot dev</code>.
          </p>
        </Panel>
      ) : heartbeat.status === 'DEGRADED' ? (
        <Panel tone="ghost" pad="md" className="border-warning/30 bg-warning/5">
          <p className="text-xs leading-relaxed text-warning">
            The bot is connected but at least one setup check failed. Review the integration
            diagnostics below, fix the listed configuration or permissions, then restart the bot.
          </p>
        </Panel>
      ) : null}

      <Panel tone="flat" pad="lg">
        <h2 className="x-eyebrow">Integration diagnostics</h2>
        <dl className="mt-4 grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Diagnostic
            label="OAuth"
            value={oauthConfigured ? 'Configured' : 'Disabled or incomplete'}
          />
          <Diagnostic
            label="Application ID"
            value={serverEnv.AUTH_DISCORD_ID ?? 'not configured'}
            mono
          />
          <Diagnostic
            label="Client secret"
            value={serverEnv.AUTH_DISCORD_SECRET ? 'Present' : 'Missing'}
          />
          <Diagnostic label="Expected callback" value={discordCallbackUrl()} mono />
          <Diagnostic
            label="Bot"
            value={
              botOnline
                ? displayDetail(botDetail.botUsername, 'Ready')
                : heartbeatFresh
                  ? 'Degraded'
                  : 'Offline'
            }
          />
          <Diagnostic
            label="Bot user ID"
            value={displayDetail(botDetail.botUserId, 'not reporting')}
            mono
          />
          <Diagnostic label="Guild" value={guild?.name ?? 'Not configured'} />
          <Diagnostic
            label="Guild ID"
            value={serverEnv.DISCORD_GUILD_ID ?? 'not configured'}
            mono
          />
          <Diagnostic
            label="Guild match"
            value={configuredGuildMatches ? 'Matches runtime configuration' : 'Mismatch or missing'}
          />
          <Diagnostic
            label="Heartbeat"
            value={heartbeat === null ? 'Never' : heartbeat.beatAt.toLocaleString('en-GB')}
          />
          <Diagnostic
            label="Gateway latency"
            value={
              typeof botDetail.gatewayLatencyMs === 'number' && botDetail.gatewayLatencyMs >= 0
                ? `${String(botDetail.gatewayLatencyMs)} ms`
                : 'Unavailable'
            }
          />
          <Diagnostic
            label="Commands"
            value={displayDetail(botDetail.commandCount, 'Not checked')}
          />
          <Diagnostic
            label="Command health"
            value={displayDetail(botDetail.commandHealth, 'Not checked')}
          />
          <Diagnostic
            label="Bot permissions"
            value={displayDetail(botDetail.permissionHealth, 'Not checked')}
          />
          <Diagnostic
            label="Role intents"
            value={displayDetail(botDetail.intents, 'Not reporting')}
          />
          <Diagnostic
            label="Review channel"
            value={guild?.reviewChannelId ?? 'Not configured'}
            mono
          />
          <Diagnostic
            label="Review channel health"
            value={displayDetail(botDetail.reviewChannelHealth, 'Not checked')}
          />
          <Diagnostic
            label="Last error"
            value={
              typeof botDetail.lastError === 'string' && botDetail.lastError !== 'none'
                ? botDetail.lastError
                : (guild?.syncError ?? 'none')
            }
          />
        </dl>
      </Panel>

      <DiscordConfig
        guild={
          guild === null
            ? null
            : {
                id: guild.id,
                guildId: guild.guildId,
                name: guild.name,
                reviewChannelId: guild.reviewChannelId,
                announcementChannelId: guild.announcementChannelId,
                logChannelId: guild.logChannelId,
                memberCount: guild.memberCount,
                syncedAt: guild.syncedAt?.toISOString() ?? null,
                syncError: guild.syncError,
              }
        }
        envGuildId={serverEnv.DISCORD_GUILD_ID ?? ''}
        roles={roles.map((role) => ({ id: role.id, key: role.key, name: role.name }))}
        mappings={(guild?.roleMappings ?? []).map((mapping) => ({
          id: mapping.id,
          roleId: mapping.roleId,
          roleName: mapping.role.name,
          discordRoleId: mapping.discordRoleId,
          discordRoleName: mapping.discordRoleName,
          syncToDiscord: mapping.syncToDiscord,
          syncFromDiscord: mapping.syncFromDiscord,
          hierarchyBlocked: mapping.hierarchyBlocked,
          lastError: mapping.lastError,
          lastSyncedAt: mapping.lastSyncedAt?.toISOString() ?? null,
        }))}
      />

      <Panel tone="ghost" pad="lg">
        <p className="x-eyebrow">Bot permissions</p>
        <ul className="mt-3 flex flex-col gap-2 text-xs leading-relaxed text-ink-muted">
          <li>
            The bot needs <strong className="text-ink-secondary">Manage Roles</strong>, and its own
            highest role must sit <em>above</em> every role it manages. A mapping shown as blocked
            below is that problem and nothing else.
          </li>
          <li>
            It does not request <strong className="text-ink-secondary">Message Content</strong>. All
            interaction is through slash commands and buttons.
          </li>
          <li>
            Do not grant it Administrator. It needs Manage Roles, View Channels, Send Messages and
            Embed Links.
          </li>
        </ul>
      </Panel>
    </ControlPage>
  );
}

function displayDetail(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return fallback;
}

function Diagnostic({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): React.ReactElement {
  return (
    <div className="min-w-0">
      <dt className="x-eyebrow">{label}</dt>
      <dd className={`mt-1 break-words text-xs text-ink-secondary ${mono ? 'font-mono' : ''}`}>
        {value}
      </dd>
    </div>
  );
}
