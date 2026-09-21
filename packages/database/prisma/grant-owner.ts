import '@xenon/config/load-env';

import { OWNER_ROLE_KEY } from '@xenon/core';

import { prisma } from '../src/client';

/**
 * Bootstrap the first Owner.
 *
 * Chicken-and-egg: granting roles requires `staff.manage`, and nobody has it on
 * a fresh install. This script is the one deliberate way out, and it runs from
 * a shell with database credentials rather than from any web surface - so the
 * escalation path requires infrastructure access, not merely a session.
 *
 * Usage, after the person has signed in once with Discord:
 *   pnpm --filter @xenon/database exec tsx prisma/grant-owner.ts <discord-user-id>
 */

async function main(): Promise<void> {
  const discordId = process.argv[2];

  if (discordId === undefined || !/^\d{17,20}$/.test(discordId)) {
    console.error(
      'Usage: tsx prisma/grant-owner.ts <discord-user-id>\n' +
        '\n' +
        'The Discord user id is the snowflake you get from right-clicking your\n' +
        'name in Discord with Developer Mode enabled. The account must have signed\n' +
        'in to XenonRP at least once so that a user record exists.',
    );
    process.exitCode = 1;
    return;
  }

  const account = await prisma.discordAccount.findUnique({
    where: { discordId },
    select: { userId: true, username: true, user: { select: { publicId: true } } },
  });

  if (account === null) {
    console.error(
      `No XenonRP account is linked to Discord id ${discordId}.\n` +
        'Sign in at the site with that Discord account first, then re-run this.',
    );
    process.exitCode = 1;
    return;
  }

  const ownerRole = await prisma.role.findUnique({
    where: { key: OWNER_ROLE_KEY },
    select: { id: true },
  });

  if (ownerRole === null) {
    console.error('The Owner role does not exist. Run `pnpm db:seed` first.');
    process.exitCode = 1;
    return;
  }

  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: account.userId, roleId: ownerRole.id } },
    create: { userId: account.userId, roleId: ownerRole.id },
    update: {},
  });

  await prisma.auditLog.create({
    data: {
      action: 'ROLE_ASSIGNED',
      actorId: null,
      actorLabel: 'Bootstrap script',
      source: 'SYSTEM',
      entityType: 'User',
      entityId: account.userId,
      entityLabel: account.user.publicId,
      after: { roleKey: OWNER_ROLE_KEY },
      metadata: { reason: 'Initial owner bootstrap via grant-owner.ts' },
    },
  });

  // eslint-disable-next-line no-console -- a CLI script's output is its result
  console.log(
    `Granted Owner to ${account.username} (${account.user.publicId}). ` +
      'Sign out and back in for the new capabilities to take effect.',
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
