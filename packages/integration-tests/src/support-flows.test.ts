import { beforeEach, describe, expect, it } from 'vitest';

import { ConflictError, ForbiddenError } from '@xenon/core';
import {
  createAppeal,
  createTicket,
  decideAppeal,
  getTicket,
  grantWhitelist,
  replyToTicket,
  revokeWhitelist,
  setUserStatus,
  updateTicket,
} from '@xenon/domain';

import { actorFor, createActor, createUser, prisma, resetDatabase } from './harness';

/**
 * Tickets, appeals and whitelist state.
 *
 * The properties worth proving here are all about who can see and do what:
 * an internal note that reaches the player is a leak, an appeal a banned
 * account cannot file is not an appeal process, and a whitelist revocation
 * that does not reach the user record is a player who is still in the city.
 */

beforeEach(async () => {
  await resetDatabase();
});

const ticket = {
  category: 'WHITELIST' as const,
  subject: 'Cannot connect after approval',
  body: 'I was approved yesterday but the server still says I am not whitelisted.',
  mediaIds: [],
};

describe('tickets', () => {
  it('runs a ticket from opening to resolution, flipping whose turn it is', async () => {
    const { user: player, actor: playerActor } = await createActor();
    const { actor: staff } = await createActor({ roleKeys: ['support'] });

    const opened = await createTicket(prisma, playerActor, ticket);
    expect(opened.status).toBe('OPEN');
    expect(opened.publicId).toMatch(/^XN-TK-\d+$/);

    const afterStaffReply = await replyToTicket(prisma, staff, {
      ticketId: opened.id,
      body: 'Thanks - can you tell us the exact error the server shows?',
      visibility: 'APPLICANT',
      mediaIds: [],
    });
    expect(afterStaffReply.status).toBe('WAITING_FOR_PLAYER');

    const afterPlayerReply = await replyToTicket(prisma, playerActor, {
      ticketId: opened.id,
      body: 'It says "You are not whitelisted".',
      visibility: 'APPLICANT',
      mediaIds: [],
    });
    expect(afterPlayerReply.status).toBe('WAITING_FOR_STAFF');

    // Only staff can move the ticket's state, and doing so tells the player.
    const manager = await createUser({ roleKeys: ['moderator'] });
    const resolved = await updateTicket(prisma, await actorFor(manager), {
      ticketId: opened.id,
      status: 'RESOLVED',
    });
    expect(resolved.status).toBe('RESOLVED');
    expect(resolved.resolvedAt).not.toBeNull();

    const notifications = await prisma.notification.count({ where: { userId: player.id } });
    expect(notifications).toBeGreaterThan(0);
  });

  it('never returns an internal note to the player who opened the ticket', async () => {
    const { actor: playerActor } = await createActor();
    const { actor: staff } = await createActor({ roleKeys: ['support'] });

    const opened = await createTicket(prisma, playerActor, ticket);

    await replyToTicket(prisma, staff, {
      ticketId: opened.id,
      body: 'Checking whether this account has an unresolved sanction.',
      visibility: 'INTERNAL',
      mediaIds: [],
    });

    const asPlayer = await getTicket(prisma, playerActor, opened.publicId);
    const bodies = (asPlayer?.messages ?? []).map((message) => message.body);
    expect(bodies.some((body) => body.includes('unresolved sanction'))).toBe(false);

    const asStaff = await getTicket(prisma, staff, opened.publicId);
    const staffBodies = (asStaff?.messages ?? []).map((message) => message.body);
    expect(staffBodies.some((body) => body.includes('unresolved sanction'))).toBe(true);
  });

  it('downgrades a player’s attempt to write an internal note', async () => {
    const { actor: playerActor } = await createActor();
    const opened = await createTicket(prisma, playerActor, ticket);

    await replyToTicket(prisma, playerActor, {
      ticketId: opened.id,
      // A hand-crafted request claiming staff visibility.
      body: 'Trying to hide this from myself.',
      visibility: 'INTERNAL',
      mediaIds: [],
    });

    const message = await prisma.ticketMessage.findFirstOrThrow({
      where: { ticketId: opened.id, body: { contains: 'hide this' } },
    });
    expect(message.visibility).toBe('APPLICANT');
  });

  it('refuses to show one player another player’s ticket', async () => {
    const { actor: playerActor } = await createActor();
    const opened = await createTicket(prisma, playerActor, ticket);

    const stranger = await createUser();
    await expect(
      getTicket(prisma, await actorFor(stranger), opened.publicId),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses a reply to a closed ticket', async () => {
    const { actor: playerActor } = await createActor();
    const { actor: manager } = await createActor({ roleKeys: ['moderator'] });

    const opened = await createTicket(prisma, playerActor, ticket);
    await updateTicket(prisma, manager, { ticketId: opened.id, status: 'CLOSED' });

    await expect(
      replyToTicket(prisma, playerActor, {
        ticketId: opened.id,
        body: 'One more thing.',
        visibility: 'APPLICANT',
        mediaIds: [],
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('appeals', () => {
  const appeal = {
    kind: 'BAN' as const,
    statement:
      'I was banned for a scene that I believe was within the rules, and I would like it reviewed.',
    mediaIds: [] as string[],
  };

  it('lets a suspended account file an appeal, which is the entire point', async () => {
    const { user } = await createActor();
    const { actor: administrator } = await createActor({ roleKeys: ['administrator'] });

    await setUserStatus(prisma, administrator, user.id, 'BANNED', 'Fixture sanction');

    // Re-resolve: the actor must reflect the account's new standing.
    const sanctioned = await actorFor(user);
    const filed = await createAppeal(prisma, sanctioned, appeal);

    expect(filed.status).toBe('SUBMITTED');
    expect(filed.publicId).toMatch(/^XN-AP-\d+$/);
  });

  it('refuses to sanction an account from staff without the capability', async () => {
    const { user } = await createActor();
    const { actor: support } = await createActor({ roleKeys: ['support'] });

    await expect(
      setUserStatus(prisma, support, user.id, 'BANNED', 'Should not be possible'),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(unchanged.status).toBe('ACTIVE');
  });

  it('allows one live appeal at a time', async () => {
    const { actor } = await createActor();
    await createAppeal(prisma, actor, appeal);

    await expect(createAppeal(prisma, actor, appeal)).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses to decide an appeal twice', async () => {
    const { actor } = await createActor();
    const { actor: administrator } = await createActor({ roleKeys: ['administrator'] });

    const filed = await createAppeal(prisma, actor, appeal);

    await decideAppeal(prisma, administrator, {
      appealId: filed.id,
      status: 'DENIED',
      decision: 'The scene was reviewed and the original decision stands.',
    });

    await expect(
      decideAppeal(prisma, administrator, {
        appealId: filed.id,
        status: 'ACCEPTED',
        decision: 'Changed my mind.',
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses an appeal decision from staff without the capability', async () => {
    const { actor } = await createActor();
    const { actor: support } = await createActor({ roleKeys: ['support'] });

    const filed = await createAppeal(prisma, actor, appeal);

    await expect(
      decideAppeal(prisma, support, {
        appealId: filed.id,
        status: 'ACCEPTED',
        decision: 'Approved by someone who should not be able to.',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('whitelist', () => {
  it('keeps the denormalised user flag in step with the whitelist record', async () => {
    const player = await createUser();
    const { actor: administrator } = await createActor({ roleKeys: ['administrator'] });

    await grantWhitelist(prisma, administrator, { userId: player.id, reason: 'Manual grant' });

    let user = await prisma.user.findUniqueOrThrow({ where: { id: player.id } });
    expect(user.whitelistState).toBe('APPROVED');

    await revokeWhitelist(prisma, administrator, { userId: player.id, reason: 'Fixture removal' });

    user = await prisma.user.findUniqueOrThrow({ where: { id: player.id } });
    expect(user.whitelistState).toBe('REVOKED');

    const record = await prisma.whitelist.findUniqueOrThrow({ where: { userId: player.id } });
    expect(record.state).toBe('REVOKED');
    expect(record.revokedAt).not.toBeNull();
    // Any state change invalidates the last successful push to the game server.
    expect(record.syncedAt).toBeNull();
  });

  it('records both sides of the change in the audit log', async () => {
    const player = await createUser();
    const { actor: administrator } = await createActor({ roleKeys: ['administrator'] });

    await grantWhitelist(prisma, administrator, { userId: player.id });
    await revokeWhitelist(prisma, administrator, { userId: player.id, reason: 'Fixture removal' });

    const entries = await prisma.auditLog.findMany({
      where: { entityType: 'whitelist' },
      orderBy: { createdAt: 'asc' },
    });

    expect(entries.map((entry) => entry.action)).toEqual([
      'whitelist.approved',
      'whitelist.revoked',
    ]);
    expect(entries[1]?.before).toMatchObject({ state: 'APPROVED' });
    expect(entries[1]?.after).toMatchObject({ state: 'REVOKED' });
  });
});
