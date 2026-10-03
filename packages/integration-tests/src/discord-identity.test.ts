import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  DiscordIdentityConflictError,
  ensureUserFromDiscord,
  syncDiscordIdentity,
} from '@xenon/domain';
import { DEV_DISCORD_FIXTURES, seedDevFixtureUsers } from '@xenon/database';

import { createTemplate, createUser, prisma, resetDatabase } from './harness';

beforeEach(async () => {
  await resetDatabase();
});

describe('Discord identity linking', () => {
  it('migrates a legacy seeded ID and preserves its Xenon data', async () => {
    const fixture = DEV_DISCORD_FIXTURES.player;
    const user = await prisma.user.create({
      data: {
        publicId: 'XN-10000',
        displayName: fixture.displayName,
        discordAccount: {
          create: {
            discordId: fixture.legacyDiscordId,
            username: fixture.username,
            globalName: fixture.displayName,
          },
        },
      },
    });
    const template = await createTemplate({ slug: 'fixture-identity-migration' });
    const submission = await prisma.applicationSubmission.create({
      data: {
        publicId: 'XN-WL-1000',
        templateId: template.id,
        applicantId: user.id,
      },
    });
    await prisma.session.create({
      data: {
        sessionToken: 'f'.repeat(64),
        userId: user.id,
        expires: new Date(Date.now() + 60_000),
      },
    });

    await seedDevFixtureUsers(prisma);

    const linked = await prisma.discordAccount.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(linked.discordId).toBe(fixture.discordId);
    expect(
      await prisma.discordAccount.findUnique({ where: { discordId: fixture.legacyDiscordId } }),
    ).toBe(null);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({
      publicId: 'XN-10000',
      displayName: fixture.displayName,
    });
    expect(
      await prisma.applicationSubmission.findUnique({ where: { id: submission.id } }),
    ).not.toBeNull();
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it('converges concurrent first logins on one canonical Xenon user', async () => {
    const profile = {
      discordId: 'test-discord-concurrent',
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
      discordId: 'test-discord-renamed',
      username: 'old-name',
      globalName: 'Old Name',
    });

    await syncDiscordIdentity(prisma, user.id, {
      discordId: 'test-discord-renamed',
      username: 'new-name',
      globalName: 'New Name',
      avatar: 'new-avatar',
    });

    const linked = await prisma.discordAccount.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(linked.discordId).toBe('test-discord-renamed');
    expect(linked.username).toBe('new-name');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).id).toBe(user.id);
  });

  it('persists Auth.js provisional UUIDs as first-login Xenon users', async () => {
    const provisionalUserId = randomUUID();

    await syncDiscordIdentity(prisma, provisionalUserId, {
      discordId: 'test-discord-first-login',
      username: 'first-login',
      globalName: 'First Login',
    });

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: provisionalUserId },
      include: { discordAccount: true, roles: { include: { role: true } } },
    });
    expect(user.publicId).toMatch(/^XN-\d+$/);
    expect(user.discordAccount?.discordId).toBe('test-discord-first-login');
    expect(user.roles.map(({ role }) => role.key)).toContain('member');
  });

  it('does not let an Auth.js provisional UUID claim an already-owned Discord identity', async () => {
    const owner = await ensureUserFromDiscord(prisma, {
      discordId: 'test-discord-owned-provisional',
      username: 'identity-owner',
    });

    await expect(
      syncDiscordIdentity(prisma, randomUUID(), {
        discordId: 'test-discord-owned-provisional',
        username: 'identity-owner',
      }),
    ).rejects.toBeInstanceOf(DiscordIdentityConflictError);

    expect(
      (
        await prisma.discordAccount.findUniqueOrThrow({
          where: { discordId: 'test-discord-owned-provisional' },
        })
      ).userId,
    ).toBe(owner.id);
  });

  it('refuses to transfer a Discord identity to a second Xenon user', async () => {
    const owner = await ensureUserFromDiscord(prisma, {
      discordId: 'test-discord-owned',
      username: 'identity-owner',
    });
    const other = await createUser({ displayName: 'Different Xenon user' });

    await expect(
      syncDiscordIdentity(prisma, other.id, {
        discordId: 'test-discord-owned',
        username: 'identity-owner',
      }),
    ).rejects.toBeInstanceOf(DiscordIdentityConflictError);

    expect(
      (
        await prisma.discordAccount.findUniqueOrThrow({
          where: { discordId: 'test-discord-owned' },
        })
      ).userId,
    ).toBe(owner.id);
  });

  it('refuses to attach a second Discord identity to one Xenon user', async () => {
    const user = await createUser({ displayName: 'One identity only' });

    await expect(
      syncDiscordIdentity(prisma, user.id, {
        discordId: 'test-discord-other',
        username: 'unexpected-second-account',
      }),
    ).rejects.toBeInstanceOf(DiscordIdentityConflictError);

    expect(await prisma.discordAccount.count({ where: { userId: user.id } })).toBe(1);
  });
});
