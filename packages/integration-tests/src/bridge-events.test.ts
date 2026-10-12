import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import type { BridgeEventInput } from '@xenon/contracts';
import { NotFoundError } from '@xenon/core';
import { pollServerStatus, recordBridgeEvent } from '@xenon/fivem';

import { createActor, prisma, resetDatabase } from './harness';

/**
 * Events the FiveM bridge reports. Each must land in the outbox exactly once
 * per bridge event id, resolve players through trusted identifiers only, and -
 * for txAdmin bans - record a FiveM moderation case without touching the
 * Xenon account.
 */

const SLUG = 'xenon-main';
const LICENSE = 'fixture-license-0100';

beforeEach(async () => {
  await resetDatabase();
  await prisma.server.create({ data: { slug: SLUG, name: 'Xenon Main' } });
});

/** A player whose licence was proven by the retired in-game flow. */
async function linkedUser() {
  const { user } = await createActor();
  await prisma.gameIdentity.create({
    data: { userId: user.id, kind: 'LICENSE', value: LICENSE, linkedVia: 'FIVEM' },
  });
  return user;
}

async function events(name: string) {
  return prisma.outboxMessage.findMany({ where: { kind: 'EVENT', name } });
}

function ban(overrides: Partial<Extract<BridgeEventInput, { type: 'PLAYER_BANNED' }>> = {}) {
  return {
    type: 'PLAYER_BANNED' as const,
    eventId: randomUUID(),
    serverSlug: SLUG,
    identifiers: [{ kind: 'LICENSE' as const, value: LICENSE }],
    playerName: 'Fixture Player',
    reason: 'RDM',
    durationSeconds: 3600,
    externalRef: 'TXA-0001',
    ...overrides,
  };
}

describe('recordBridgeEvent', () => {
  it('rejects an unknown server slug and records nothing', async () => {
    await expect(
      recordBridgeEvent(prisma, {
        type: 'SERVER_RESTART_SCHEDULED',
        eventId: randomUUID(),
        serverSlug: 'not-a-server',
        secondsRemaining: 300,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await prisma.outboxMessage.count({ where: { kind: 'EVENT' } })).toBe(0);
  });

  it('records a connection once per event id, resolved through a trusted identifier', async () => {
    const user = await linkedUser();
    const input = {
      type: 'PLAYER_CONNECTED' as const,
      eventId: randomUUID(),
      serverSlug: SLUG,
      identifiers: [{ kind: 'LICENSE' as const, value: LICENSE }],
      playerName: 'Fixture Player',
    };

    await recordBridgeEvent(prisma, input);
    await recordBridgeEvent(prisma, input);

    const rows = await events('PLAYER_CONNECTED');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dedupeKey).toBe(`event:bridge:${input.eventId}`);
    expect(rows[0]?.payload).toMatchObject({ serverSlug: SLUG, playerPublicId: user.publicId });

    const identity = await prisma.gameIdentity.findFirstOrThrow({ where: { userId: user.id } });
    expect(identity.lastSeenAt).not.toBeNull();
  });

  it('does not resolve a player from a spoofable identifier', async () => {
    const { user } = await createActor();
    await prisma.gameIdentity.create({
      data: { userId: user.id, kind: 'DISCORD', value: '123456789012345678' },
    });

    await recordBridgeEvent(prisma, {
      type: 'PLAYER_DISCONNECTED',
      eventId: randomUUID(),
      serverSlug: SLUG,
      identifiers: [{ kind: 'DISCORD', value: '123456789012345678' }],
      playerName: 'Impostor',
      reason: 'Exiting',
    });

    const rows = await events('PLAYER_DISCONNECTED');
    expect(rows[0]?.payload).toMatchObject({ playerPublicId: null, reason: 'Exiting' });
  });

  it('records a txAdmin restart with an absolute restart time', async () => {
    const before = Date.now();
    await recordBridgeEvent(prisma, {
      type: 'SERVER_RESTART_SCHEDULED',
      eventId: randomUUID(),
      serverSlug: SLUG,
      secondsRemaining: 600,
    });

    const [row] = await events('SERVER_RESTART_SCHEDULED');
    expect(row?.payload).toMatchObject({ origin: 'TXADMIN', secondsRemaining: 600 });
    const payload = row?.payload;
    const restartAt =
      typeof payload === 'object' && payload !== null && 'restartAt' in payload
        ? payload.restartAt
        : null;
    if (typeof restartAt !== 'string') throw new Error('restartAt missing from payload');
    expect(Date.parse(restartAt)).toBeGreaterThanOrEqual(before + 600_000);
  });
});

describe('txAdmin bans', () => {
  it('creates exactly one case on duplicate delivery and leaves the account alone', async () => {
    const user = await linkedUser();
    await prisma.user.update({ where: { id: user.id }, data: { whitelistState: 'APPROVED' } });

    const input = ban();
    const first = await recordBridgeEvent(prisma, input);
    const again = await recordBridgeEvent(prisma, input);
    // The same txAdmin action re-sent under a fresh bridge event id.
    await recordBridgeEvent(prisma, { ...input, eventId: randomUUID() });

    const cases = await prisma.moderationCase.findMany();
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      userId: user.id,
      identifierHash: null,
      scope: 'FIVEM',
      kind: 'BAN',
      source: 'FIVEM',
      externalRef: 'TXA-0001',
      reason: 'RDM',
    });
    expect(cases[0]?.expiresAt?.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
    expect(again.caseId).toBe(first.caseId);

    const announced = await events('PLAYER_BANNED');
    expect(announced).toHaveLength(1);
    expect(announced[0]?.payload).toMatchObject({
      playerPublicId: user.publicId,
      scope: 'FIVEM',
      caseId: first.caseId,
    });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.status).toBe('ACTIVE');
    expect(after.whitelistState).toBe('APPROVED');
  });

  it('stores only a hash of the identifier when no account matches', async () => {
    const result = await recordBridgeEvent(
      prisma,
      ban({
        identifiers: [{ kind: 'LICENSE', value: 'unlinked-license-value' }],
        durationSeconds: null,
        externalRef: null,
      }),
    );

    const stored = await prisma.moderationCase.findUniqueOrThrow({
      where: { id: result.caseId ?? '' },
    });
    expect(stored.userId).toBeNull();
    expect(stored.expiresAt).toBeNull();
    expect(stored.identifierHash).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(stored)).not.toContain('unlinked-license-value');
  });
});

describe('pollServerStatus', () => {
  it('announces the first reading and later changes, not unchanged readings', async () => {
    const server = await prisma.server.findUniqueOrThrow({ where: { slug: SLUG } });

    await pollServerStatus(prisma, server.id);
    await pollServerStatus(prisma, server.id);
    expect(await events('SERVER_STATUS_CHANGED')).toHaveLength(1);

    // The mock adapter always reports online; simulate an outage in between.
    // Dated ahead so it is the newest reading when the next poll looks back.
    await prisma.serverStatusSnapshot.create({
      data: { serverId: server.id, online: false, createdAt: new Date(Date.now() + 60_000) },
    });
    await pollServerStatus(prisma, server.id);

    const rows = await events('SERVER_STATUS_CHANGED');
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ previousOnline: null, online: true }),
        expect.objectContaining({ previousOnline: false, online: true }),
      ]),
    );
  });
});
