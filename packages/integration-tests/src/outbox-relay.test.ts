import { beforeEach, describe, expect, it, vi } from 'vitest';

import { emitIntegrationEvent, enqueueDurable } from '@xenon/jobs';
import { silentLogger } from '@xenon/logger';
import { deliverIntegrationEvent } from '@xenon/worker/event-delivery';
import { relayOutbox, type RelayEnqueue } from '@xenon/worker/outbox-relay';

import { prisma, resetDatabase } from './harness';

/**
 * The outbox is the durability boundary between a committed decision and its
 * side effects. These tests run the real relay SQL (`FOR UPDATE SKIP LOCKED`)
 * against PostgreSQL with a fake queue, so what is proven is the claim/mark
 * behaviour, not a mock of it.
 */

beforeEach(async () => {
  await resetDatabase();
});

function recordingQueue() {
  const added: { name: string; payload: unknown; jobId: string }[] = [];
  const enqueue: RelayEnqueue = (name, payload, options) => {
    added.push({ name, payload, jobId: options.jobId });
    return Promise.resolve();
  };
  return { added, enqueue };
}

const approvedEvent = {
  type: 'WHITELIST_APPROVED',
  payload: { playerPublicId: 'XN-10001', discordId: null, applicationPublicId: 'XN-WL-1' },
  idempotencyKey: 'application.approved:fixture',
  source: 'WEB',
} as const;

describe('outbox relay', () => {
  it('dispatches a job exactly once, even when the relay runs again', async () => {
    await enqueueDurable('discord.role.sync', { userId: 'u1', reason: 'test' });
    const queue = recordingQueue();

    const first = await relayOutbox({ db: prisma, enqueue: queue.enqueue, logger: silentLogger });
    const second = await relayOutbox({ db: prisma, enqueue: queue.enqueue, logger: silentLogger });

    expect(first.dispatched).toBe(1);
    expect(second.claimed).toBe(0);
    expect(queue.added).toHaveLength(1);
    expect(queue.added[0]?.name).toBe('discord.role.sync');
    expect(queue.added[0]?.jobId).not.toContain(':');
  });

  it('collapses a duplicate emission with the same idempotency key', async () => {
    await emitIntegrationEvent(prisma, approvedEvent);
    await emitIntegrationEvent(prisma, approvedEvent);

    expect(await prisma.outboxMessage.count({ where: { kind: 'EVENT' } })).toBe(1);
  });

  it('fans an event out to its subscribers and skips events nobody consumes', async () => {
    await emitIntegrationEvent(prisma, approvedEvent);
    await emitIntegrationEvent(prisma, {
      type: 'PLAYER_CONNECTED',
      payload: { serverSlug: 'main', playerPublicId: null, playerName: 'Fixture' },
      idempotencyKey: 'bridge:fixture-connect',
      source: 'FIVEM',
    });
    const queue = recordingQueue();

    await relayOutbox({ db: prisma, enqueue: queue.enqueue, logger: silentLogger });

    expect(queue.added.map((job) => job.name)).toEqual(['integration.event.deliver']);
    expect(queue.added[0]?.payload).toMatchObject({ subscriber: 'link' });
    // Both rows are finished: the unsubscribed one has nothing left to do.
    expect(await prisma.outboxMessage.count({ where: { dispatchedAt: null } })).toBe(0);
  });

  it('keeps a row pending with backoff when the queue is down', async () => {
    await enqueueDurable('fivem.whitelist.sync', { userId: 'u1', reason: 'test' });

    const result = await relayOutbox({
      db: prisma,
      enqueue: () => Promise.reject(new Error('connect ECONNREFUSED redis://user:pw@host:6379')),
      logger: silentLogger,
    });

    expect(result.failed).toBe(1);
    const row = await prisma.outboxMessage.findFirstOrThrow();
    expect(row.dispatchedAt).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.availableAt.getTime()).toBeGreaterThan(Date.now());
    // The connection string never reaches the stored error.
    expect(row.lastError).not.toContain('pw@');
  });

  it('does not dispatch a delayed job before it is due', async () => {
    await enqueueDurable(
      'announcement.publish',
      { articleId: 'a1' },
      { delayMs: 60 * 60_000, dedupeKey: 'announcement:a1' },
    );
    const queue = recordingQueue();

    await relayOutbox({ db: prisma, enqueue: queue.enqueue, logger: silentLogger });

    expect(queue.added).toHaveLength(0);
  });
});

describe('integration event delivery', () => {
  it('delivers once and acknowledges a retried delivery without calling Link again', async () => {
    await emitIntegrationEvent(prisma, approvedEvent);
    const row = await prisma.outboxMessage.findFirstOrThrow({ where: { kind: 'EVENT' } });
    const gateway = vi.fn(() => Promise.resolve({ accepted: true }));
    const deps = { db: prisma, gateway: gateway as never, logger: silentLogger };

    await deliverIntegrationEvent(deps, { outboxId: row.id, subscriber: 'link' });
    await deliverIntegrationEvent(deps, { outboxId: row.id, subscriber: 'link' });

    expect(gateway).toHaveBeenCalledTimes(1);
    expect(gateway).toHaveBeenCalledWith(
      'events.deliver',
      expect.objectContaining({
        id: row.id,
        type: 'WHITELIST_APPROVED',
        version: 1,
        idempotencyKey: approvedEvent.idempotencyKey,
      }),
    );
    expect(await prisma.integrationEventReceipt.count()).toBe(1);
  });

  it('writes no receipt when Link refuses, so the job retries', async () => {
    await emitIntegrationEvent(prisma, approvedEvent);
    const row = await prisma.outboxMessage.findFirstOrThrow({ where: { kind: 'EVENT' } });
    const gateway = vi.fn(() => Promise.reject(new Error('Link unreachable')));

    await expect(
      deliverIntegrationEvent(
        { db: prisma, gateway: gateway, logger: silentLogger },
        { outboxId: row.id, subscriber: 'link' },
      ),
    ).rejects.toThrow('Link unreachable');
    expect(await prisma.integrationEventReceipt.count()).toBe(0);
  });
});
