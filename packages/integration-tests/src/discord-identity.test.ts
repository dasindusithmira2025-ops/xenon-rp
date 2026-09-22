import { beforeEach, describe, expect, it } from 'vitest';

import {
  DiscordIdentityConflictError,
  ensureUserFromDiscord,
  syncDiscordIdentity,
} from '@xenon/domain';

import { createUser, prisma, resetDatabase } from './harness';

beforeEach(async () => {
  await resetDatabase();
});

describe('Discord identity linking', () => {
  it('converges concurrent first logins on one canonical Xenon user', async () => {
    const profile = {
      discordId: '90000000000000009999',
      username: 'xenon-player',
      globalName: 'Xenon Player',
      avatar: 'avatar-hash',
    };

    const [first, second] = await Promise.all([
      ensureUserFromDiscord(prisma, profile),
      ensureUserFromDiscord(prisma, profile),
    ]);

    expect(first.id).toBe(second.id);
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.discordAccount.count()).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { action: 'discord.account_linked', entityLabel: first.publicId },
      }),
    ).toBe(1);
  });

  it('synchronizes a renamed profile without changing the Xenon identity', async () => {
    const user = await ensureUserFromDiscord(prisma, {
      discordId: '90000000000000009998',
      username: 'old-name',
      globalName: 'Old Name',
    });

    await syncDiscordIdentity(prisma, user.id, {
      discordId: '90000000000000009998',
      username: 'new-name',
      globalName: 'New Name',
      avatar: 'new-avatar',
    });

    const linked = await prisma.discordAccount.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(linked.discordId).toBe('90000000000000009998');
    expect(linked.username).toBe('new-name');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).id).toBe(user.id);
  });

  it('refuses to transfer a Discord identity to a second Xenon user', async () => {
    const owner = await ensureUserFromDiscord(prisma, {
      discordId: '90000000000000009997',
      username: 'identity-owner',
    });
    const other = await createUser({ displayName: 'Different Xenon user' });

    await expect(
      syncDiscordIdentity(prisma, other.id, {
        discordId: '90000000000000009997',
        username: 'identity-owner',
      }),
    ).rejects.toBeInstanceOf(DiscordIdentityConflictError);

    expect(
      (
        await prisma.discordAccount.findUniqueOrThrow({
          where: { discordId: '90000000000000009997' },
        })
      ).userId,
    ).toBe(owner.id);
  });

  it('refuses to attach a second Discord identity to one Xenon user', async () => {
    const user = await createUser({ displayName: 'One identity only' });

    await expect(
      syncDiscordIdentity(prisma, user.id, {
        discordId: '90000000000000009996',
        username: 'unexpected-second-account',
      }),
    ).rejects.toBeInstanceOf(DiscordIdentityConflictError);

    expect(await prisma.discordAccount.count({ where: { userId: user.id } })).toBe(1);
  });
});
