import type {
  Db,
  Notification,
  NotificationChannel,
  NotificationType,
  Prisma,
} from '@xenon/database';
import { enqueueBestEffort } from '@xenon/jobs';

/**
 * The notification service.
 *
 * One entry point for every message the platform sends a player, so that
 * "approved in Discord" and "approved on the website" produce the same record
 * and the same delivery attempts.
 *
 * Ordering is the whole point: the row is written inside the caller's
 * transaction, and delivery is enqueued afterwards. A Discord outage therefore
 * costs a DM, never the decision that caused it.
 */

export interface NotifyInput {
  readonly userId: string;
  readonly type: NotificationType;
  readonly title: string;
  readonly body: string;
  /** In-app destination, e.g. `/portal/applications/XN-WL-1842`. */
  readonly href?: string | null;
  readonly channels?: readonly NotificationChannel[];
  readonly metadata?: Prisma.InputJsonValue;
}

/**
 * Create a notification row.
 *
 * Takes a `Db` so it can join the caller's transaction. Does **not** enqueue:
 * call `dispatchPending` after the transaction commits, or use `notifyNow`
 * when there is no surrounding transaction.
 */
export async function createNotification(db: Db, input: NotifyInput): Promise<Notification> {
  const channels = input.channels ?? ['WEB', 'DISCORD_DM'];

  return db.notification.create({
    data: {
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      href: input.href ?? null,
      channels: [...channels],
      // A notification that was never asked to go to Discord is SKIPPED rather
      // than PENDING, so the pending count means "owed a delivery".
      discordState: channels.includes('DISCORD_DM') ? 'PENDING' : 'SKIPPED',
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    },
  });
}

/** Enqueue delivery for notifications already written. Safe to call twice. */
export async function dispatchPending(notifications: readonly Notification[]): Promise<void> {
  for (const notification of notifications) {
    if (notification.discordState !== 'PENDING') continue;
    await enqueueBestEffort('discord.dm', { notificationId: notification.id });
  }
}

/** Create and immediately schedule delivery. For callers outside a transaction. */
export async function notifyNow(db: Db, input: NotifyInput): Promise<Notification> {
  const notification = await createNotification(db, input);
  await dispatchPending([notification]);
  return notification;
}

/** Notify several users with the same message, e.g. an announcement. */
export async function notifyMany(
  db: Db,
  userIds: readonly string[],
  input: Omit<NotifyInput, 'userId'>,
): Promise<number> {
  const created: Notification[] = [];
  for (const userId of userIds) {
    created.push(await createNotification(db, { ...input, userId }));
  }
  await dispatchPending(created);
  return created.length;
}

export interface NotificationPage {
  readonly items: readonly Notification[];
  readonly unreadCount: number;
  readonly hasMore: boolean;
}

/** A page of a user's notifications, newest first, with the unread badge count. */
export async function listNotifications(
  db: Db,
  userId: string,
  options: { take?: number; skip?: number; unreadOnly?: boolean } = {},
): Promise<NotificationPage> {
  const take = Math.min(options.take ?? 20, 100);
  const skip = options.skip ?? 0;

  const where = {
    userId,
    ...(options.unreadOnly === true ? { webReadAt: null } : {}),
  };

  const [items, unreadCount] = await Promise.all([
    db.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      // One extra row answers "is there another page" without a second count.
      take: take + 1,
      skip,
    }),
    db.notification.count({ where: { userId, webReadAt: null } }),
  ]);

  return {
    items: items.slice(0, take),
    unreadCount,
    hasMore: items.length > take,
  };
}

/** Mark one notification read. Scoped by user so an id alone is not enough. */
export async function markNotificationRead(
  db: Db,
  userId: string,
  notificationId: string,
): Promise<void> {
  await db.notification.updateMany({
    where: { id: notificationId, userId, webReadAt: null },
    data: { webReadAt: new Date() },
  });
}

export async function markAllNotificationsRead(db: Db, userId: string): Promise<number> {
  const result = await db.notification.updateMany({
    where: { userId, webReadAt: null },
    data: { webReadAt: new Date() },
  });
  return result.count;
}

/** Record the outcome of a Discord delivery attempt. Called by the worker. */
export async function recordDiscordDelivery(
  db: Db,
  notificationId: string,
  outcome: { delivered: boolean; error?: string },
): Promise<void> {
  await db.notification.update({
    where: { id: notificationId },
    data: outcome.delivered
      ? { discordState: 'SENT', discordSentAt: new Date(), discordError: null }
      : // A closed DM is a permanent, expected condition, not an incident: it is
        // recorded so staff can see it and never retried into oblivion.
        { discordState: 'FAILED', discordError: (outcome.error ?? 'Unknown error').slice(0, 500) },
  });
}
