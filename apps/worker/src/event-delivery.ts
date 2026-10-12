import { parseIntegrationEvent } from '@xenon/contracts';
import { IntegrationError } from '@xenon/core';
import type { Db } from '@xenon/database';
import type { JobPayloads } from '@xenon/jobs';
import type { Logger } from '@xenon/logger';

import type { GatewayCall } from './gateway-client';

/**
 * Deliver one outbox event to one subscriber.
 *
 * At-least-once on the wire, exactly-once in effect: the receipt row is
 * checked first and written last, and Link de-duplicates on the event id, so
 * a retry after a crash between the two re-sends an event Link already
 * accepted and nothing is shown twice.
 */

export interface EventDeliveryDeps {
  readonly db: Db;
  readonly gateway: GatewayCall;
  readonly logger: Logger;
}

const EVENT_KEY_PREFIX = 'event:';

export async function deliverIntegrationEvent(
  deps: EventDeliveryDeps,
  { outboxId, subscriber }: JobPayloads['integration.event.deliver'],
): Promise<void> {
  const { db, gateway, logger } = deps;

  const receipt = await db.integrationEventReceipt.findUnique({
    where: { consumer_eventId: { consumer: subscriber, eventId: outboxId } },
    select: { eventId: true },
  });
  if (receipt !== null) return;

  const row = await db.outboxMessage.findUnique({ where: { id: outboxId } });
  if (row?.kind !== 'EVENT') {
    logger.warn({ outboxId, subscriber }, 'Integration event disappeared before delivery');
    return;
  }

  const parsed = parseIntegrationEvent({
    id: row.id,
    idempotencyKey: row.dedupeKey?.startsWith(EVENT_KEY_PREFIX)
      ? row.dedupeKey.slice(EVENT_KEY_PREFIX.length)
      : row.id,
    occurredAt: row.createdAt.toISOString(),
    source: row.source,
    type: row.name,
    version: row.version,
    payload: row.payload,
  });
  if (!parsed.ok) {
    // Emission validates payloads, so this is a schema skew between this
    // worker and the row's writer. Retrying cannot fix it.
    throw new IntegrationError('outbox', `Event ${outboxId} is invalid: ${parsed.error}`, {
      retryable: false,
    });
  }

  await gateway('events.deliver', parsed.event);
  await db.integrationEventReceipt.createMany({
    data: [{ consumer: subscriber, eventId: outboxId }],
    skipDuplicates: true,
  });
}
