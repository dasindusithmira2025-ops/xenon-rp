import { createHash } from 'node:crypto';

import { expireStaleSubmissions } from '@xenon/applications';
import { IntegrationError } from '@xenon/core';
import { type Db, transaction } from '@xenon/database';
import {
  buildNotificationEmbed,
  loadSupportSettings,
  syncGuildMembership,
  syncUserRoles,
  updateGuildMembership,
  xenonIds,
  XenonAnnouncementPanel,
  XenonTicketPanel,
} from '@xenon/discord';
import {
  eventDiscordId,
  expireRoleAssignments,
  liftExpiredSuspensions,
  pruneStatusSnapshots,
  publishScheduledAnnouncement,
} from '@xenon/domain';
import {
  pollServerStatus,
  pruneCfxLinkAttempts,
  pruneLinkTokens,
  syncWhitelistForUser,
} from '@xenon/fivem';
import { emitIntegrationEvent, type JobName, type JobPayloads } from '@xenon/jobs';
import type { Logger } from '@xenon/logger';
import { recordDiscordDelivery } from '@xenon/notifications';
import { systemActor } from '@xenon/permissions';

import { deliverIntegrationEvent } from './event-delivery';
import { DiscordRequestError, type GatewayCall } from './gateway-client';
import { gatewayMessage } from './message';
import { gatewayMembershipPort, gatewayRolePort } from './ports';
import { postOrUpdateReviewCard } from './review-card';

/**
 * Job handlers.
 *
 * Everything the platform does to a system it does not own happens here,
 * after the canonical decision has committed to Postgres. Discord effects go
 * through Xenon Link's gateway - the worker holds no bot token - and FXServer
 * is reached through the FiveM adapter. Every handler must be safe to run
 * twice: the outbox relay and BullMQ both deliver at least once.
 *
 * A handler either succeeds or throws. Link being unreachable throws a
 * retryable error and BullMQ backs off; a refusal that cannot change on retry
 * is thrown as permanent and recorded, never retried forever.
 */

export interface HandlerDeps {
  readonly db: Db;
  readonly gateway: GatewayCall;
  readonly logger: Logger;
  /** Public website origin for links in Discord messages. */
  readonly siteUrl: string;
  /** `DISCORD_GUILD_ID`: the guild the primary guild row must match. */
  readonly guildId: string;
  /** False in production with a localhost site URL: never post dead links. */
  readonly linksAllowed: boolean;
}

export type Handlers = {
  readonly [TName in JobName]: (payload: JobPayloads[TName]) => Promise<void>;
};

/** Discord's "Cannot send messages to this user": the player blocks server DMs. */
const DMS_CLOSED = 50007;
/** Unknown guild / missing access: the configured guild is wrong or Link was removed. */
const GUILD_INACCESSIBLE = new Set([10004, 50001]);

const OUTBOX_RETENTION_DAYS = 14;
const RECEIPT_RETENTION_DAYS = 30;

/** Tone for the notification embed, from the notification type. */
function toneFor(type: string): 'success' | 'danger' | 'warning' | 'info' | 'neutral' {
  if (type.endsWith('APPROVED') || type === 'WHITELIST_GRANTED') return 'success';
  if (type.endsWith('REJECTED') || type === 'WHITELIST_REVOKED') return 'danger';
  if (type.endsWith('CHANGES_REQUESTED') || type.includes('INTERVIEW')) return 'warning';
  if (type === 'SYSTEM_ANNOUNCEMENT') return 'info';
  return 'neutral';
}

function isDiscordCode(error: unknown, codes: number | ReadonlySet<number>): boolean {
  if (!(error instanceof DiscordRequestError)) return false;
  return typeof codes === 'number' ? error.code === codes : codes.has(error.code);
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

/**
 * Stable per day and per distinct failure, so a job retrying the same broken
 * mapping reports once a day rather than once per attempt.
 */
function roleSyncFailureKey(userId: string, errors: readonly string[]): string {
  const digest = createHash('sha256').update(errors.join('\n')).digest('hex').slice(0, 12);
  return `role_sync_failed:${userId}:${digest}:${new Date().toISOString().slice(0, 10)}`;
}

export function createHandlers(deps: HandlerDeps): Handlers {
  const { db, gateway, logger, siteUrl, guildId } = deps;
  const reviewCard = { db, gateway, logger, siteUrl, guildId };

  return {
    'discord.ticket.created': async ({ ticketId }) => {
      const supportSettings = await loadSupportSettings(db);
      if (!supportSettings.dmNotifications) return;

      const ticket = await db.ticket.findUnique({
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

      const panel = XenonTicketPanel({
        ticketId: ticket.publicId,
        category: ticket.category.toLowerCase().replaceAll('_', ' '),
        createdBy: 'You',
        createdAt: ticket.createdAt,
        portalUrl: new URL(`/portal/tickets/${ticket.publicId}`, siteUrl).toString(),
        ...(ticket.status === 'CLOSED'
          ? { closed: true }
          : supportSettings.allowDiscordClose
            ? { closeCustomId: xenonIds.ticketClose(ticket.publicId) }
            : { canClose: false }),
      });
      const message = gatewayMessage({ embeds: panel.embeds, components: panel.components });

      const previous = await db.discordMessageReference.findFirst({
        where: { ticketId, kind: 'TICKET_DM', deletedAt: null },
        orderBy: { createdAt: 'asc' },
      });
      if (previous !== null) {
        const { found } = await gateway('message.edit', {
          channelId: previous.channelId,
          messageId: previous.messageId,
          message,
        });
        if (found) return;
      }

      let sent;
      try {
        sent = await gateway('message.send', {
          target: { kind: 'dm', discordUserId: discordId },
          message,
        });
      } catch (error) {
        if (isDiscordCode(error, DMS_CLOSED)) {
          logger.info({ ticketId }, 'Ticket DM not delivered: the player has DMs closed');
          return;
        }
        throw error;
      }
      await db.discordMessageReference.create({
        data: {
          kind: 'TICKET_DM',
          channelId: sent.channelId,
          messageId: sent.messageId,
          ticketId,
          entityType: 'ticket_notification',
          entityId: ticketId,
        },
      });
    },

    'announcement.publish': async ({ articleId }) => {
      await publishScheduledAnnouncement(db, articleId);
    },

    'discord.review.post': async ({ submissionId }) => {
      await postOrUpdateReviewCard(reviewCard, submissionId);
    },

    'discord.review.update': async ({ submissionId }) => {
      await postOrUpdateReviewCard(reviewCard, submissionId);
    },

    'discord.dm': async ({ notificationId }) => {
      const notification = await db.notification.findUnique({
        where: { id: notificationId },
        include: { user: { select: { discordAccount: { select: { discordId: true } } } } },
      });
      if (notification === null || notification.discordState === 'SENT') return;

      const discordId = notification.user.discordAccount?.discordId;
      if (discordId === undefined) {
        await recordDiscordDelivery(db, notificationId, {
          delivered: false,
          error: 'No linked Discord account',
        });
        return;
      }

      try {
        await gateway('message.send', {
          target: { kind: 'dm', discordUserId: discordId },
          message: gatewayMessage({
            embeds: [
              buildNotificationEmbed({
                title: notification.title,
                body: notification.body,
                href: notification.href,
                siteUrl,
                tone: toneFor(notification.type),
              }).toJSON(),
            ],
          }),
        });
      } catch (error) {
        // Permanent and expected: recorded so the player sees it in their
        // notification centre, never retried.
        if (isDiscordCode(error, DMS_CLOSED)) {
          await recordDiscordDelivery(db, notificationId, {
            delivered: false,
            error: 'This player has direct messages closed',
          });
          return;
        }
        throw error;
      }
      await recordDiscordDelivery(db, notificationId, { delivered: true });
    },

    'discord.channel.post': async ({ channelId, kind, entityType, entityId }) => {
      if (kind !== 'ANNOUNCEMENT') return;

      const article = await db.article.findUnique({ where: { id: entityId } });
      if (article === null) {
        logger.warn({ entityType, entityId }, 'Announcement disappeared before it was posted');
        return;
      }
      if (article.announcedAt !== null) return;

      const embed = XenonAnnouncementPanel({
        type: article.announcementType,
        title: article.title,
        message: article.excerpt ?? '',
        readMoreUrl:
          article.publishToWebsite && article.status === 'PUBLISHED' && deps.linksAllowed
            ? new URL(`/news/${article.slug}`, siteUrl).toString()
            : null,
        effectiveAt: article.scheduledAt,
      });
      const notifyRole = article.discordNotifyRoleId;
      const message = gatewayMessage({
        ...(notifyRole === null
          ? {}
          : { content: `<@&${notifyRole}>`, allowedRoleMentions: [notifyRole] }),
        embeds: [embed.toJSON()],
      });

      const existing = await db.discordMessageReference.findFirst({
        where: { entityType: 'announcement', entityId, channelId, deletedAt: null },
      });
      if (existing !== null) {
        const { found } = await gateway('message.edit', {
          channelId: existing.channelId,
          messageId: existing.messageId,
          message,
        });
        if (found) {
          await db.article.update({ where: { id: entityId }, data: { announcedAt: new Date() } });
          return;
        }
      }

      const sent = await gateway('message.send', {
        target: { kind: 'channel', channelId },
        message,
      });
      await transaction(db, async (tx) => {
        await tx.discordMessageReference.create({
          data: {
            kind: 'ANNOUNCEMENT',
            channelId: sent.channelId,
            messageId: sent.messageId,
            entityType,
            entityId,
          },
        });
        // Marks it posted so a re-run of the same announcement does not duplicate.
        await tx.article.update({ where: { id: entityId }, data: { announcedAt: new Date() } });
      });
    },

    'discord.role.sync': async ({ userId, reason }) => {
      const outcome = await syncUserRoles(db, gatewayRolePort(gateway), userId);

      if (outcome.memberMissing) {
        // Not in the guild. Their roles reconcile when they join; the cached
        // membership flag is corrected now.
        const account = await db.discordAccount.findUnique({
          where: { userId },
          select: { discordId: true },
        });
        if (account !== null) {
          await updateGuildMembership(db, account.discordId, {
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

      if (outcome.permanentErrors.includes('Xenon user no longer exists')) {
        throw new IntegrationError('discord', 'Role sync target no longer exists', {
          retryable: false,
        });
      }

      const failures = [
        ...outcome.permanentErrors,
        ...outcome.blocked.map((roleId) => `role ${roleId} is above Xenon Link's highest role`),
      ];
      if (failures.length > 0) {
        logger.error(
          { userId, reason, issues: failures },
          'Role synchronization needs an operator fix; it will not retry',
        );
        const user = await db.user.findUnique({
          where: { id: userId },
          select: { publicId: true, discordAccount: { select: { discordId: true } } },
        });
        if (user !== null) {
          await emitIntegrationEvent(db, {
            type: 'ROLE_SYNC_FAILED',
            payload: {
              playerPublicId: user.publicId,
              discordId: eventDiscordId(user.discordAccount?.discordId),
              errors: failures.slice(0, 10).map((failure) => failure.slice(0, 200)),
            },
            idempotencyKey: roleSyncFailureKey(userId, failures),
            source: 'SYSTEM',
          });
        }
        return;
      }

      logger.debug(
        { userId, reason, added: outcome.add.length, removed: outcome.remove.length },
        'Roles reconciled',
      );
    },

    'discord.guild.sync': async ({ guildId: rowId }) => {
      const row = await db.discordGuild.findUnique({ where: { id: rowId } });
      if (row === null) return;

      if (row.guildId !== guildId) {
        await db.discordGuild.update({
          where: { id: rowId },
          data: { syncError: 'Configured guild does not match DISCORD_GUILD_ID' },
        });
        return;
      }

      try {
        const guild = await gateway('guild.info', {});
        await db.discordGuild.update({
          where: { id: rowId },
          data: {
            name: guild.name,
            iconUrl: guild.iconUrl,
            memberCount: guild.memberCount,
            syncedAt: new Date(),
            syncError: null,
          },
        });
      } catch (error) {
        await db.discordGuild.update({
          where: { id: rowId },
          data: {
            syncError: (error instanceof Error ? error.message : 'Unknown error').slice(0, 500),
          },
        });
        throw error;
      }
    },

    'discord.membership.sync': async ({ userId, reason }) => {
      const account = await db.discordAccount.findUnique({
        where: { userId },
        select: { discordId: true },
      });
      if (account === null) return;

      const guildRow = await db.discordGuild.findFirst({
        where: { isPrimary: true },
        select: { guildId: true },
      });
      if (guildRow?.guildId !== guildId) {
        await updateGuildMembership(db, account.discordId, {
          state: 'MISCONFIGURED',
          error: 'Xenon primary guild does not match DISCORD_GUILD_ID',
        });
        logger.error({ userId, reason }, 'Membership check has a guild configuration mismatch');
        return;
      }

      try {
        const state = await syncGuildMembership(
          db,
          gatewayMembershipPort(gateway),
          account.discordId,
        );
        logger.debug({ userId, reason, state }, 'Guild membership snapshot refreshed');
      } catch (error) {
        if (isDiscordCode(error, GUILD_INACCESSIBLE)) {
          await updateGuildMembership(db, account.discordId, {
            state: 'MISCONFIGURED',
            error: 'Xenon Link cannot access the configured Xenon guild',
          });
          logger.error({ userId, reason }, 'Xenon Link cannot access the configured guild');
          return;
        }
        // `syncGuildMembership` already recorded UNAVAILABLE.
        throw new IntegrationError('discord', 'Membership lookup failed', {
          cause: error,
          retryable: true,
        });
      }
    },

    'fivem.whitelist.sync': async ({ userId, reason }) => {
      const result = await syncWhitelistForUser(db, userId);
      logger.debug({ userId, reason, pushed: result.pushed }, 'Whitelist pushed');
    },

    'fivem.status.poll': async ({ serverId }) => {
      await pollServerStatus(db, serverId);
    },

    'applications.expire': async () => {
      const expired = await expireStaleSubmissions(db, systemActor);
      const roles = await expireRoleAssignments(db);
      const suspensions = await liftExpiredSuspensions(db, systemActor);
      if (expired + roles + suspensions > 0) {
        logger.info({ expired, roles, suspensions }, 'Expiry sweep');
      }
    },

    'maintenance.cleanup': async () => {
      const tokens = await pruneLinkTokens(db);
      const cfxAttempts = await pruneCfxLinkAttempts(db);
      const snapshots = await pruneStatusSnapshots(db);
      const outbox = await db.outboxMessage.deleteMany({
        where: { dispatchedAt: { not: null, lt: daysAgo(OUTBOX_RETENTION_DAYS) } },
      });
      const receipts = await db.integrationEventReceipt.deleteMany({
        where: { processedAt: { lt: daysAgo(RECEIPT_RETENTION_DAYS) } },
      });
      if (tokens + cfxAttempts + snapshots + outbox.count + receipts.count > 0) {
        logger.info(
          { tokens, cfxAttempts, snapshots, outbox: outbox.count, receipts: receipts.count },
          'Cleanup sweep',
        );
      }
    },

    'integration.event.deliver': async (payload) => {
      await deliverIntegrationEvent({ db, gateway, logger }, payload);
    },
  };
}
