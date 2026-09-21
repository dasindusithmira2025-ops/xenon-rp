import { isStaff } from '@xenon/auth';
import { prisma } from '@xenon/database';

import { signOutAction } from '~/app/(site)/signin/actions';
import { PortalShell } from '~/components/portal/portal-shell';
import { requireSignedIn } from '~/server/context';

/**
 * Portal shell.
 *
 * Every route under /portal requires a session. The check is here rather than
 * repeated in each page, so a new route cannot be added without it - and
 * `unauthorized()` renders the 401 boundary rather than redirecting, which
 * keeps the URL so signing in returns the player to where they were going.
 */
export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactElement> {
  const actor = await requireSignedIn();

  const [user, unread] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: actor.userId ?? '' },
      select: { publicId: true, displayName: true, avatarUrl: true, whitelistState: true },
    }),
    prisma.notification.count({ where: { userId: actor.userId ?? '', webReadAt: null } }),
  ]);

  return (
    <PortalShell
      viewer={{
        publicId: user.publicId,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        whitelistState: user.whitelistState,
        unreadNotifications: unread,
        isStaff: isStaff(actor),
      }}
      signOut={signOutAction}
    >
      {children}
    </PortalShell>
  );
}
