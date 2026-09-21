import { prisma } from '@xenon/database';
import { listNotifications } from '@xenon/notifications';
import { EmptyState } from '@xenon/ui';

import type { Metadata } from 'next';

import { NotificationList } from '~/components/portal/notification-list';
import { PortalPage } from '~/components/portal/portal-page';
import { requireUserId } from '~/server/context';

export const metadata: Metadata = {
  title: 'Notifications',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * /portal/notifications
 *
 * The durable record. Discord delivery is a best-effort mirror that can fail -
 * closed DMs, a rate limit, the bot being down - so this page is the one place
 * a notification is guaranteed to exist.
 */
export default async function NotificationsPage(): Promise<React.ReactElement> {
  const userId = await requireUserId();
  const page = await listNotifications(prisma, userId, { take: 50 });

  return (
    <PortalPage
      title="Notifications"
      lead={
        page.unreadCount > 0
          ? `${String(page.unreadCount)} unread`
          : 'Everything here is also delivered to your Discord DMs when they are open.'
      }
    >
      {page.items.length === 0 ? (
        <EmptyState
          title="Nothing yet"
          description="Application decisions, ticket replies and whitelist changes all appear here."
        />
      ) : (
        <NotificationList
          unreadCount={page.unreadCount}
          items={page.items.map((notification) => ({
            id: notification.id,
            type: notification.type,
            title: notification.title,
            body: notification.body,
            href: notification.href,
            createdAt: notification.createdAt.toISOString(),
            read: notification.webReadAt !== null,
            discordState: notification.discordState,
          }))}
        />
      )}
    </PortalPage>
  );
}
