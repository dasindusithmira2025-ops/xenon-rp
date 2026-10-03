import { ChannelType, PermissionFlagsBits, type Client } from 'discord.js';

import { prisma } from '@xenon/database';

import { commandDefinitions } from '../discord/commands';
import { botEnv, logger } from '../runtime';

export interface DiscordDiagnostics {
  readonly status: 'HEALTHY' | 'DEGRADED';
  readonly detail: Record<string, string | number | boolean>;
}

/** Read-only startup checks for the configured Xenon bot installation. */
export async function inspectDiscordInstallation(client: Client): Promise<DiscordDiagnostics> {
  const issues: string[] = [];
  const detail: Record<string, string | number | boolean> = {
    discordMode: botEnv.DISCORD_MODE,
    gatewayState: client.isReady() ? 'READY' : 'DISCONNECTED',
    applicationId: botEnv.DISCORD_APPLICATION_ID ?? 'missing',
    botUserId: client.user?.id ?? 'missing',
    botUsername: client.user?.username ?? 'missing',
    guildId: botEnv.DISCORD_GUILD_ID ?? 'missing',
    gatewayLatencyMs: client.ws.ping,
    intents: 'Guilds, GuildVoiceStates',
  };

  if (botEnv.DISCORD_GUILD_ID === undefined) {
    return {
      status: 'DEGRADED',
      detail: { ...detail, lastError: 'DISCORD_GUILD_ID is not configured' },
    };
  }

  let guild;
  try {
    guild = await client.guilds.fetch(botEnv.DISCORD_GUILD_ID);
  } catch (error) {
    logger.error(
      { err: error, guildId: botEnv.DISCORD_GUILD_ID },
      'Configured Discord guild is unreachable',
    );
    return {
      status: 'DEGRADED',
      detail: {
        ...detail,
        lastError: 'Configured guild is unreachable or the bot is not installed',
      },
    };
  }

  detail.guildName = guild.name;
  detail.guildReachable = true;

  const primary = await prisma.discordGuild.findFirst({
    where: { isPrimary: true },
    include: { roleMappings: true },
  });
  if (primary === null) {
    issues.push('No primary guild is configured in Xenon Control');
  } else if (primary.guildId !== botEnv.DISCORD_GUILD_ID) {
    issues.push('The Xenon primary guild does not match DISCORD_GUILD_ID');
  }

  let botMember;
  try {
    botMember = guild.members.me ?? (await guild.members.fetchMe());
  } catch (error) {
    logger.error({ err: error, guildId: guild.id }, 'Could not inspect the Xenon bot member');
    return {
      status: 'DEGRADED',
      detail: { ...detail, guildName: guild.name, lastError: 'Bot member could not be inspected' },
    };
  }

  if (
    (primary?.roleMappings.length ?? 0) > 0 &&
    !botMember.permissions.has(PermissionFlagsBits.ManageRoles)
  ) {
    issues.push('MISSING MANAGE_ROLES');
  }

  const roleIssues: string[] = [];
  for (const mapping of primary?.roleMappings ?? []) {
    try {
      const role = await guild.roles.fetch(mapping.discordRoleId);
      if (role === null) {
        roleIssues.push(`ROLE_NOT_FOUND ${mapping.discordRoleId}`);
        await prisma.discordRoleMapping.update({
          where: { id: mapping.id },
          data: { hierarchyBlocked: false, lastError: 'Discord role no longer exists' },
        });
      } else if (botMember.roles.highest.comparePositionTo(role) <= 0) {
        roleIssues.push(`BOT_ROLE_TOO_LOW ${mapping.discordRoleId}`);
        await prisma.discordRoleMapping.update({
          where: { id: mapping.id },
          data: { hierarchyBlocked: true, lastError: 'Bot role is below this role' },
        });
      } else {
        await prisma.discordRoleMapping.update({
          where: { id: mapping.id },
          data: { hierarchyBlocked: false, lastError: null },
        });
      }
    } catch (error) {
      logger.warn(
        { err: error, roleId: mapping.discordRoleId },
        'Could not inspect a mapped Discord role',
      );
      roleIssues.push(`ROLE_LOOKUP_FAILED ${mapping.discordRoleId}`);
    }
  }
  if (roleIssues.length > 0) issues.push(...roleIssues);
  detail.mappedRoleCount = primary?.roleMappings.length ?? 0;
  detail.roleHealth = roleIssues.length === 0 ? 'HEALTHY' : roleIssues.join('; ');

  const reviewChannelId = primary?.reviewChannelId ?? null;
  detail.reviewChannelId = reviewChannelId ?? 'not configured';
  if (reviewChannelId === null) {
    issues.push('Review channel is not configured');
    detail.reviewChannelHealth = 'NOT_CONFIGURED';
  } else {
    try {
      const channel = await guild.channels.fetch(reviewChannelId);
      if (channel?.type !== ChannelType.GuildText) {
        issues.push('Review channel is missing or is not a text channel in the configured guild');
        detail.reviewChannelHealth = 'WRONG_GUILD_OR_CHANNEL_TYPE';
      } else {
        const permissions = channel.permissionsFor(botMember);
        const missing: string[] = [];
        if (!permissions.has(PermissionFlagsBits.ViewChannel)) missing.push('VIEW_CHANNEL');
        if (!permissions.has(PermissionFlagsBits.SendMessages)) missing.push('SEND_MESSAGES');
        if (!permissions.has(PermissionFlagsBits.EmbedLinks)) missing.push('EMBED_LINKS');
        if (!permissions.has(PermissionFlagsBits.ReadMessageHistory)) {
          missing.push('READ_MESSAGE_HISTORY');
        }
        detail.reviewChannelHealth =
          missing.length === 0 ? 'HEALTHY' : `MISSING ${missing.join(', ')}`;
        if (missing.length > 0) issues.push(`Review channel missing ${missing.join(', ')}`);
      }
    } catch (error) {
      logger.warn(
        { err: error, channelId: reviewChannelId },
        'Could not inspect the review channel',
      );
      issues.push('Review channel is unreachable');
      detail.reviewChannelHealth = 'UNREACHABLE';
    }
  }

  try {
    const registered = await guild.commands.fetch();
    const required = new Set(commandDefinitions.map((command) => command.name));
    const missing = [...required].filter(
      (name) => !registered.some((command) => command.name === name),
    );
    detail.commandCount = registered.size;
    detail.commandHealth = missing.length === 0 ? 'HEALTHY' : `MISSING ${missing.join(', ')}`;
    if (missing.length > 0) issues.push(`Commands not registered: ${missing.join(', ')}`);
  } catch (error) {
    logger.warn(
      { err: error, guildId: guild.id },
      'Could not inspect registered application commands',
    );
    detail.commandCount = 0;
    detail.commandHealth = 'UNAVAILABLE';
    issues.push('Command registration could not be verified');
  }

  detail.permissionHealth = issues.length === 0 ? 'HEALTHY' : 'DEGRADED';
  detail.lastError = issues.join('; ') || 'none';

  return { status: issues.length === 0 ? 'HEALTHY' : 'DEGRADED', detail };
}
