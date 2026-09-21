'use client';

import { CheckCheck, MailWarning } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Button, cn, Panel, Tooltip, useToast } from '@xenon/ui';

import {
  markAllNotificationsReadAction,
  markNotificationReadAction,
} from '~/app/(portal)/portal/actions';

/**
 * Notification centre.
 *
 * Opening one marks it read optimistically so the badge responds immediately;
 * the server call follows and the router refresh reconciles. A failed mark is
 * not worth interrupting a navigation over - the row simply stays unread on the
 * next load.
 *
 * A failed Discord delivery is surfaced rather than hidden. "We tried to DM you
 * and your DMs are closed" is useful information; silently swallowing it means
 * players believe they were never told.
 */

export interface NotificationRecord {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly body: string;
  readonly href: string | null;
  readonly createdAt: string;
  readonly read: boolean;
  readonly discordState: string;
}

export function NotificationList({
  items,
  unreadCount,
}: {
  items: readonly NotificationRecord[];
  unreadCount: number;
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [locallyRead, setLocallyRead] = React.useState<ReadonlySet<string>>(new Set());
  const [pending, startTransition] = React.useTransition();

  const markRead = (id: string): void => {
    setLocallyRead((current) => new Set(current).add(id));
    void markNotificationReadAction(id);
  };

  const markAll = (): void => {
    startTransition(async () => {
      const result = await markAllNotificationsReadAction();
      if (result.ok) {
        setLocallyRead(new Set(items.map((item) => item.id)));
        router.refresh();
        return;
      }
      toast.error('Could not update', result.message);
    });
  };

  return (
    <div className="flex flex-col gap-4">
      {unreadCount > 0 ? (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" loading={pending} onClick={markAll}>
            <CheckCheck /> Mark all read
          </Button>
        </div>
      ) : null}

      <Panel tone="flat" pad="none" className="divide-y divide-line">
        {items.map((notification) => {
          const read = notification.read || locallyRead.has(notification.id);
          const Wrapper = notification.href === null ? 'div' : Link;

          return (
            <Wrapper
              key={notification.id}
              // `Link` needs href; the div branch ignores it.
              href={notification.href ?? '#'}
              onClick={() => {
                if (!read) markRead(notification.id);
              }}
              className={cn(
                'flex gap-4 p-5 transition-colors',
                notification.href === null ? '' : 'hover:bg-elevated',
                read ? 'opacity-65' : '',
              )}
            >
              <span
                className={cn(
                  'mt-1.5 size-1.5 shrink-0 rounded-full',
                  read ? 'bg-transparent' : 'bg-xenon',
                )}
                aria-label={read ? undefined : 'Unread'}
              />

              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <p className="font-medium text-ink">{notification.title}</p>
                  <time
                    className="font-mono text-[0.625rem] tracking-[0.12em] text-ink-muted uppercase"
                    dateTime={notification.createdAt}
                  >
                    {new Date(notification.createdAt).toLocaleString('en-GB', {
                      day: '2-digit',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </time>
                  {notification.discordState === 'FAILED' ? (
                    <Tooltip content="We could not deliver this to your Discord DMs. Your privacy settings may block messages from server members.">
                      <span className="inline-flex items-center gap-1 text-[0.625rem] text-warning">
                        <MailWarning className="size-3" aria-hidden /> DM failed
                      </span>
                    </Tooltip>
                  ) : null}
                </div>

                <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink-secondary">
                  {notification.body}
                </p>
              </div>
            </Wrapper>
          );
        })}
      </Panel>
    </div>
  );
}
