import { forbidden } from 'next/navigation';

import { isStaff } from '@xenon/auth';
import { prisma } from '@xenon/database';
import { allSettings } from '@xenon/domain';

import type { Metadata } from 'next';

import { ControlShell } from '~/components/control/control-shell';
import { requireSignedIn } from '~/server/context';

export const metadata: Metadata = {
  title: { default: 'Control', template: '%s | Xenon Control' },
  robots: { index: false, follow: false, nocache: true },
};

/**
 * Control centre shell.
 *
 * The gate is "holds at least one staff capability", which is the honest
 * meaning of "is staff" in a capability-based system - there is no staff flag
 * to check, and there should not be.
 *
 * This is the outer boundary only. Every page inside asserts the specific
 * capability it needs, because "can see the control centre" and "can approve an
 * application" are different questions.
 */
export default async function ControlLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactElement> {
  const actor = await requireSignedIn();
  if (!isStaff(actor)) forbidden();

  const [user, settings] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: actor.userId ?? '' },
      select: {
        publicId: true,
        displayName: true,
        avatarUrl: true,
        roles: { select: { role: { select: { name: true, priority: true } } } },
      },
    }),
    allSettings(prisma),
  ]);

  const roleNames = user.roles
    .sort((a, b) => b.role.priority - a.role.priority)
    .map((assignment) => assignment.role.name);

  return (
    <ControlShell
      fixturesLoaded={settings['dev.fixturesLoaded'] === 'true'}
      viewer={{
        publicId: user.publicId,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        permissions: [...actor.permissions],
        roleNames,
      }}
    >
      {children}
    </ControlShell>
  );
}
