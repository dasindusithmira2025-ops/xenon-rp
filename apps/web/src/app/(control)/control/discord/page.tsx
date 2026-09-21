import { serverEnv } from '@xenon/config/server';
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

  const botOnline = heartbeat !== null && Date.now() - heartbeat.beatAt.getTime() < 90_000;

  return (
    <ControlPage
      title="Discord"
      lead="Xenon owns role membership; Discord mirrors it. Nothing here grants a permission - it decides which Discord role reflects a Xenon role."
      actions={
        <Badge tone={botOnline ? 'success' : 'warning'}>
          {botOnline ? 'Bot online' : 'Bot not reporting'}
        </Badge>
      }
    >
      {botOnline ? null : (
        <Panel tone="ghost" pad="md" className="border-warning/30 bg-warning/5">
          <p className="text-xs leading-relaxed text-warning">
            The bot has not sent a heartbeat recently. Role synchronisation, review cards and direct
            messages are queued and will be delivered when it comes back - nothing is lost. Start it
            with <code className="font-mono">pnpm --filter @xenon/bot dev</code>.
          </p>
        </Panel>
      )}

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
        envGuildId={serverEnv.DISCORD_GUILD_ID}
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
