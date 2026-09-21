import { DiscordAPIError } from 'discord.js';
import { expireStaleSubmissions } from '@xenon/applications';
import { IntegrationError } from '@xenon/core';
import { prisma } from '@xenon/database';
import { buildNotificationEmbed, syncUserRoles, updateGuildMembership } from '@xenon/discord';
import {
  expireRoleAssignments,
  liftExpiredSuspensions,
  pruneStatusSnapshots,
  recordStatusSnapshot,
} from '@xenon/domain';
import { pollServerStatus, pruneLinkTokens, syncWhitelistForUser } from '@xenon/fivem';
import { recordDiscordDelivery } from '@xenon/notifications';
import { systemActor } from '@xenon/permissions';
import { discordClient, isDiscordReady, primaryGuild } from '../discord/client';
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
function toneFor(type) {
  if (type.endsWith('APPROVED') || type === 'WHITELIST_GRANTED') return 'success';
  if (type.endsWith('REJECTED') || type === 'WHITELIST_REVOKED') return 'danger';
  if (type.endsWith('CHANGES_REQUESTED') || type.includes('INTERVIEW')) return 'warning';
  if (type === 'SYSTEM_ANNOUNCEMENT') return 'info';
  return 'neutral';
}
/** Throws when Discord is configured but unreachable; returns false when it is not configured. */
function requireDiscord(job) {
  if (!hasRealDiscordCredentials()) {
    logger.debug({ job }, 'Discord is not configured; skipping');
    return false;
  }
  if (!isDiscordReady()) {
    throw new IntegrationError('discord', 'Gateway is not connected', { retryable: true });
  }
  return true;
}
export const handlers = {
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
    const channel = await client.channels.fetch(channelId);
    if (channel === null || !channel.isTextBased() || !('send' in channel)) {
      throw new IntegrationError('discord', `Channel ${channelId} is not postable`, {
        retryable: false,
      });
    }
    const message = await channel.send({
      embeds: [
        buildNotificationEmbed({
          title: article.title,
          body: article.excerpt ?? '',
          href: `/news/${article.slug}`,
          siteUrl: botEnv.NEXT_PUBLIC_SITE_URL,
          tone: 'info',
        }),
      ],
    });
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
        await updateGuildMembership(prisma, account.discordId, { isMember: false });
      }
      return;
    }
    if (outcome.errors.length > 0) {
      throw new IntegrationError('discord', outcome.errors.join('; '), { retryable: true });
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
    const client = discordClient();
    if (client === null) return;
    try {
      const guild = await client.guilds.fetch(row.guildId);
      const members = await guild.members.fetch();
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
      // Refresh the cached membership projection in one pass, which is what
      // makes the "must be in the Discord" application requirement accurate.
      const accounts = await prisma.discordAccount.findMany({
        select: { discordId: true, isGuildMember: true },
      });
      for (const account of accounts) {
        const member = members.get(account.discordId);
        const isMember = member !== undefined;
        if (isMember === account.isGuildMember) continue;
        await updateGuildMembership(prisma, account.discordId, {
          isMember,
          nickname: member?.nickname ?? null,
          joinedAt: member?.joinedAt ?? null,
          roleIds: member === undefined ? [] : [...member.roles.cache.keys()],
        });
      }
    } catch (error) {
      await prisma.discordGuild.update({
        where: { id: guildId },
        data: { syncError: error instanceof Error ? error.message : 'Unknown error' },
      });
      throw error;
    }
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
export async function pollAllServers() {
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
//# sourceMappingURL=handlers.js.map
