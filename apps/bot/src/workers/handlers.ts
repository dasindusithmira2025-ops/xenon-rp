import { DiscordAPIError } from 'discord.js';

import { expireStaleSubmissions } from '@xenon/applications';
import { IntegrationError } from '@xenon/core';
import { prisma } from '@xenon/database';
import {
  buildNotificationEmbed,
  loadSupportSettings,
  xenonIds,
  XenonAnnouncementPanel,
  XenonTicketPanel,
  syncGuildMembership,
  syncUserRoles,
  updateGuildMembership,
} from '@xenon/discord';
import {
  expireRoleAssignments,
  liftExpiredSuspensions,
  pruneStatusSnapshots,
  publishScheduledAnnouncement,
  recordStatusSnapshot,
} from '@xenon/domain';
import { pollServerStatus, pruneLinkTokens, syncWhitelistForUser } from '@xenon/fivem';
import type { JobName, JobPayloads } from '@xenon/jobs';
import { recordDiscordDelivery } from '@xenon/notifications';
import { systemActor } from '@xenon/permissions';

import { discordClient, isDiscordReady, primaryGuild } from '../discord/client';
import { guildMembershipPort } from '../discord/membership-port';
import { linksAllowed } from '../discord/provisioning/context';
import { executeProvisionRun } from '../discord/provisioning/runner';
import { postOrUpdateReviewCard } from '../discord/review-card';
import { guildRolePort } from '../discord/role-port';
import { botEnv, hasRealDiscordCredentials, logger } from '../runtime';

/**
 * Job handlers.
 *
 * Everything the platform does to a system it does not own happens here, after
 * the canonical decision has already committed to Postgres. That ordering is
 * why a Discord outage during an approval costs a message rather than the
 * approval - and why every handler must be safe to run twice.
 *
 * Two distinct "cannot do this" cases, handled differently:
 *
 *  - Not configured. A fresh clone has placeholder credentials. The handler
 *    logs and returns, because retrying against a token that will never work
 *    is just noise.
 *  - Configured but unavailable. The handler throws, BullMQ backs off, and the
 *    work is delivered when the service returns.
 */

/** Tone for the notification embed, from the notification type. */
function toneFor(type: string): 'success' | 'danger' | 'warning' | 'info' | 'neutral' {
  if (type.endsWith('APPROVED') || type === 'WHITELIST_GRANTED') return 'success';
  if (type.endsWith('REJECTED') || type === 'WHITELIST_REVOKED') return 'danger';
  if (type.endsWith('CHANGES_REQUESTED') || type.includes('INTERVIEW')) return 'warning';
  if (type === 'SYSTEM_ANNOUNCEMENT') return 'info';
  return 'neutral';
}

/** Throws when Discord is configured but unreachable; returns false when it is not configured. */
function requireDiscord(job: JobName): boolean {
  if (!hasRealDiscordCredentials()) {
    logger.debug({ job }, 'Discord is not configured; skipping');
    return false;
  }

  if (!isDiscordReady()) {
    throw new IntegrationError('discord', 'Gateway is not connected', { retryable: true });
  }

  return true;
}

type Handlers = {
  [TName in JobName]: (payload: JobPayloads[TName]) => Promise<void>;
};

export const handlers: Handlers = {
  'discord.setup.run': async ({ runId }) => {
    // Provisioning is never retried by the queue, so a run that cannot start
    // is closed with a reason instead of sitting QUEUED in the Control Center.
    const client = hasRealDiscordCredentials() && isDiscordReady() ? discordClient() : null;
    if (client === null) {
      await prisma.discordProvisionRun.updateMany({
        where: { id: runId, status: 'QUEUED' },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          failure: hasRealDiscordCredentials()
            ? 'The bot is not connected to Discord. Start it and try again.'
            : 'Discord is disabled in this environment.',
        },
      });
      return;
    }

    await executeProvisionRun(client, runId);
  },

  'discord.ticket.created': async ({ ticketId }) => {
    if (!requireDiscord('discord.ticket.created')) return;
    const supportSettings = await loadSupportSettings(prisma);
    if (!supportSettings.dmNotifications) return;
    const client = discordClient();
    if (client === null) return;

    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      select: {
        id: true,
        publicId: true,
        category: true,
        status: true,
        createdAt: true,
        author: { select: { discordAccount: { select: { discordId: true } } } },
      },
    });
    const discordId = ticket?.author.discordAccount?.discordId;
    if (ticket === null || discordId === undefined) return;

    const user = await client.users.fetch(discordId);
    const dm = await user.createDM();
    const previous = await prisma.discordMessageReference.findFirst({
      where: { ticketId, kind: 'TICKET_DM', deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    const panel = XenonTicketPanel({
      ticketId: ticket.publicId,
      category: ticket.category.toLowerCase().replaceAll('_', ' '),
      createdBy: 'You',
      createdAt: ticket.createdAt,
      portalUrl: new URL(
        `/portal/tickets/${ticket.publicId}`,
        botEnv.NEXT_PUBLIC_SITE_URL,
      ).toString(),
      ...(ticket.status === 'CLOSED'
        ? { closed: true }
        : supportSettings.allowDiscordClose
          ? { closeCustomId: xenonIds.ticketClose(ticket.publicId) }
          : { canClose: false }),
    });

    if (previous !== null) {
      const existing = await dm.messages.fetch(previous.messageId).catch(() => null);
      if (existing !== null) {
        await existing.edit({ embeds: panel.embeds, components: panel.components });
        return;
      }
    }

    let message;
    try {
      message = await user.send({ embeds: panel.embeds, components: panel.components });
    } catch (error) {
      if (error instanceof DiscordAPIError && error.code === 50007) {
        logger.info({ ticketId }, 'Ticket DM was not delivered because the player has DMs closed');
        return;
      }
      throw error;
    }
    await prisma.discordMessageReference.create({
      data: {
        kind: 'TICKET_DM',
        channelId: dm.id,
        messageId: message.id,
        ticketId,
        entityType: 'ticket_notification',
        entityId: ticketId,
      },
    });
  },

  'discord.welcome.delete': async ({ channelId, messageId }) => {
    if (!requireDiscord('discord.welcome.delete')) return;
    const client = discordClient();
    if (client === null) return;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel === null || !channel.isTextBased() || !('messages' in channel)) return;
    await channel.messages.delete(messageId).catch((error: unknown) => {
      if (error instanceof DiscordAPIError && error.code === 10008) return;
      throw error;
    });
  },

  'announcement.publish': async ({ articleId }) => {
    await publishScheduledAnnouncement(prisma, articleId);
  },

  'discord.review.post': async ({ submissionId }) => {
    if (!requireDiscord('discord.review.post')) return;
    const client = discordClient();
    if (client === null) return;

    await postOrUpdateReviewCard(client, submissionId);
  },

  'discord.review.update': async ({ submissionId }) => {
    if (!requireDiscord('discord.review.update')) return;
    const client = discordClient();
    if (client === null) return;

    await postOrUpdateReviewCard(client, submissionId);
  },

  'discord.dm': async ({ notificationId }) => {
    const notification = await prisma.notification.findUnique({
      where: { id: notificationId },
      include: { user: { select: { discordAccount: { select: { discordId: true } } } } },
    });

    if (notification === null) return;
    if (notification.discordState === 'SENT') return;

    if (!hasRealDiscordCredentials()) {
      // Recorded as skipped rather than failed: nothing went wrong, the
      // integration simply does not exist in this environment.
      await recordDiscordDelivery(prisma, notificationId, {
        delivered: false,
        error: 'Discord is not configured in this environment',
      });
      return;
    }

    if (!isDiscordReady()) {
      throw new IntegrationError('discord', 'Gateway is not connected', { retryable: true });
    }

    const discordId = notification.user.discordAccount?.discordId;
    if (discordId === undefined) {
      await recordDiscordDelivery(prisma, notificationId, {
        delivered: false,
        error: 'No linked Discord account',
      });
      return;
    }

    const client = discordClient();
    if (client === null) return;

    try {
      const user = await client.users.fetch(discordId);
      await user.send({
        embeds: [
          buildNotificationEmbed({
            title: notification.title,
            body: notification.body,
            href: notification.href,
            siteUrl: botEnv.NEXT_PUBLIC_SITE_URL,
            tone: toneFor(notification.type),
          }),
        ],
      });

      await recordDiscordDelivery(prisma, notificationId, { delivered: true });
    } catch (error) {
      // 50007 is "Cannot send messages to this user": their privacy settings
      // block DMs from server members. Permanent and expected - recorded so the
      // player can see it in their notification centre, never retried.
      if (error instanceof DiscordAPIError && error.code === 50007) {
        await recordDiscordDelivery(prisma, notificationId, {
          delivered: false,
          error: 'This player has direct messages closed',
        });
        return;
      }
      throw error;
    }
  },

  'discord.channel.post': async ({ channelId, kind, entityType, entityId }) => {
    if (!requireDiscord('discord.channel.post')) return;
    const client = discordClient();
    if (client === null) return;

    if (kind !== 'ANNOUNCEMENT') return;

    const article = await prisma.article.findUnique({ where: { id: entityId } });
    if (article === null) {
      logger.warn({ entityType, entityId }, 'Announcement disappeared before it was posted');
      return;
    }

    if (article.announcedAt !== null) return;

    const channel = await client.channels.fetch(channelId);
    if (channel === null || !channel.isTextBased() || !('send' in channel)) {
      throw new IntegrationError('discord', `Channel ${channelId} is not postable`, {
        retryable: false,
      });
    }

    const existingReference = await prisma.discordMessageReference.findFirst({
      where: { entityType: 'announcement', entityId, channelId, deletedAt: null },
    });
    const embed = XenonAnnouncementPanel({
      type: article.announcementType,
      title: article.title,
      message: article.excerpt ?? '',
      readMoreUrl:
        article.publishToWebsite && article.status === 'PUBLISHED' && linksAllowed()
          ? new URL(`/news/${article.slug}`, botEnv.NEXT_PUBLIC_SITE_URL).toString()
          : null,
      effectiveAt: article.scheduledAt,
    });
    const payload = {
      ...(article.discordNotifyRoleId === null
        ? {}
        : { content: `<@&${article.discordNotifyRoleId}>` }),
      embeds: [embed],
      allowedMentions: {
        parse: [] as const,
        roles: article.discordNotifyRoleId === null ? [] : [article.discordNotifyRoleId],
      },
    };
    if (existingReference !== null) {
      const existing = await channel.messages.fetch(existingReference.messageId).catch(() => null);
      if (existing !== null) {
        await existing.edit(payload);
        await prisma.article.update({ where: { id: entityId }, data: { announcedAt: new Date() } });
        return;
      }
    }

    const message = await channel.send(payload);

    await prisma.$transaction([
      prisma.discordMessageReference.create({
        data: {
          kind: 'ANNOUNCEMENT',
          channelId,
          messageId: message.id,
          entityType,
          entityId,
        },
      }),
      // Marks it posted so a re-run of the same announcement does not duplicate.
      prisma.article.update({ where: { id: entityId }, data: { announcedAt: new Date() } }),
    ]);
  },

  'discord.role.sync': async ({ userId, reason }) => {
    if (!requireDiscord('discord.role.sync')) return;

    const guild = await primaryGuild();
    if (guild === null) {
      throw new IntegrationError('discord', 'Primary guild is unreachable', { retryable: true });
    }

    const outcome = await syncUserRoles(prisma, guildRolePort(guild), userId);

    if (outcome.memberMissing) {
      // Not in the guild. Their roles will reconcile when they join, and the
      // cached membership flag is corrected now.
      const account = await prisma.discordAccount.findUnique({
        where: { userId },
        select: { discordId: true },
      });
      if (account !== null) {
        await updateGuildMembership(prisma, account.discordId, {
          state: 'NOT_MEMBER',
          nickname: null,
          joinedAt: null,
          roleIds: [],
        });
      }
      return;
    }

    if (outcome.errors.length > 0) {
      throw new IntegrationError('discord', outcome.errors.join('; '), { retryable: true });
    }

    if (outcome.permanentErrors.length > 0) {
      logger.error(
        { userId, reason, issues: outcome.permanentErrors },
        'Role synchronization needs an operator fix; the failed job will not retry',
      );
      if (outcome.permanentErrors.includes('Xenon user no longer exists')) {
        throw new IntegrationError('discord', 'Role sync target no longer exists', {
          retryable: false,
        });
      }
      return;
    }

    if (outcome.blocked.length > 0) {
      logger.warn(
        { userId, reason, blockedRoleIds: outcome.blocked },
        'Role synchronization is blocked by Discord hierarchy',
      );
      return;
    }

    logger.debug(
      { userId, reason, added: outcome.add.length, removed: outcome.remove.length },
      'Roles reconciled',
    );
  },

  'discord.guild.sync': async ({ guildId }) => {
    if (!requireDiscord('discord.guild.sync')) return;

    const row = await prisma.discordGuild.findUnique({ where: { id: guildId } });
    if (row === null) return;

    if (row.guildId !== botEnv.DISCORD_GUILD_ID) {
      await prisma.discordGuild.update({
        where: { id: guildId },
        data: { syncError: 'Configured guild does not match DISCORD_GUILD_ID' },
      });
      return;
    }

    const client = discordClient();
    if (client === null) return;

    try {
      const guild = await client.guilds.fetch(row.guildId);

      await prisma.discordGuild.update({
        where: { id: guildId },
        data: {
          name: guild.name,
          iconUrl: guild.iconURL(),
          memberCount: guild.memberCount,
          syncedAt: new Date(),
          syncError: null,
        },
      });
    } catch (error) {
      await prisma.discordGuild.update({
        where: { id: guildId },
        data: { syncError: error instanceof Error ? error.message : 'Unknown error' },
      });
      throw error;
    }
  },

  'discord.membership.sync': async ({ userId, reason }) => {
    if (!requireDiscord('discord.membership.sync')) return;

    const account = await prisma.discordAccount.findUnique({
      where: { userId },
      select: { discordId: true },
    });
    if (account === null) return;

    const guildRow = await prisma.discordGuild.findFirst({
      where: { isPrimary: true },
      select: { id: true, guildId: true },
    });
    if (
      guildRow === null ||
      botEnv.DISCORD_GUILD_ID === undefined ||
      guildRow.guildId !== botEnv.DISCORD_GUILD_ID
    ) {
      await updateGuildMembership(prisma, account.discordId, {
        state: 'MISCONFIGURED',
        error: 'Xenon primary guild does not match DISCORD_GUILD_ID',
      });
      logger.error(
        { userId, reason },
        'Discord membership check has a guild configuration mismatch',
      );
      return;
    }

    const client = discordClient();
    if (client === null) return;

    let guild;
    try {
      guild = await client.guilds.fetch(botEnv.DISCORD_GUILD_ID);
    } catch (error) {
      if (error instanceof DiscordAPIError && (error.code === 10004 || error.code === 50001)) {
        await updateGuildMembership(prisma, account.discordId, {
          state: 'MISCONFIGURED',
          error: 'The bot cannot access the configured Xenon guild',
        });
        logger.error({ userId, reason }, 'Bot cannot access the configured Xenon guild');
        return;
      }

      await updateGuildMembership(prisma, account.discordId, {
        state: 'UNAVAILABLE',
        error: 'Discord could not confirm this membership right now',
      });
      throw new IntegrationError('discord', 'Guild lookup failed', {
        cause: error,
        retryable: true,
      });
    }

    const state = await syncGuildMembership(prisma, guildMembershipPort(guild), account.discordId);
    logger.debug({ userId, reason, state }, 'Guild membership snapshot refreshed');
  },

  'fivem.whitelist.sync': async ({ userId, reason }) => {
    const result = await syncWhitelistForUser(prisma, userId);
    logger.debug({ userId, reason, pushed: result.pushed }, 'Whitelist pushed');
  },

  'fivem.status.poll': async ({ serverId }) => {
    await pollServerStatus(prisma, serverId);
  },

  'applications.expire': async () => {
    const expired = await expireStaleSubmissions(prisma, systemActor);
    const roles = await expireRoleAssignments(prisma);
    const suspensions = await liftExpiredSuspensions(prisma, systemActor);

    if (expired + roles + suspensions > 0) {
      logger.info({ expired, roles, suspensions }, 'Expiry sweep');
    }
  },

  'maintenance.cleanup': async () => {
    const tokens = await pruneLinkTokens(prisma);
    const snapshots = await pruneStatusSnapshots(prisma);

    if (tokens + snapshots > 0) {
      logger.info({ tokens, snapshots }, 'Cleanup sweep');
    }
  },
};

/** Status polling is scheduled rather than queued per request. */
export async function pollAllServers(): Promise<void> {
  const servers = await prisma.server.findMany({ select: { id: true } });
  for (const server of servers) {
    try {
      await pollServerStatus(prisma, server.id);
    } catch (error) {
      // A probe failure is already recorded as a snapshot with an error; this
      // catch exists so one bad server does not stop the others being polled.
      logger.warn({ err: error, serverId: server.id }, 'Status poll failed');
    }
  }
}

export { recordStatusSnapshot };
