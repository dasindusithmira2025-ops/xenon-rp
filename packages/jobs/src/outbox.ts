import {
  EVENT_VERSIONS,
  type IntegrationEventPayload,
  type IntegrationEventType,
  validateEventPayload,
} from '@xenon/contracts';
import { prisma, type ActionSource, type Db } from '@xenon/database';

import type { JobName, JobPayloads } from './contracts';

/**
 * The transactional outbox.
 *
 * Side effects are recorded in Postgres, not pushed to Redis inline. Pass the
 * transaction handle (`db`) from inside `transaction()` and the side effect
 * commits — or rolls back — with the decision that caused it. The worker's
 * relay then moves due rows onto the BullMQ queue (jobs) or fans them out to
 * subscribers (events). Redis being down delays work; it can no longer lose it.
 */

export interface DurableEnqueueOptions {
  /** Transaction or client to write through. Defaults to the shared client. */
  readonly db?: Db;
  /** Delay before the relay dispatches the job. */
  readonly delayMs?: number;
  /**
   * Permanent de-duplication key. A second write with the same key is a no-op
   * forever, so use it only for intents that must happen at most once (e.g.
   * "post the announcement for article X"), never for convergent syncs.
   */
  readonly dedupeKey?: string;
}

/** Record a job in the outbox. The relay enqueues it once `delayMs` has elapsed. */
export async function enqueueDurable<TName extends JobName>(
  name: TName,
  payload: JobPayloads[TName],
  options: DurableEnqueueOptions = {},
): Promise<void> {
  const db = options.db ?? prisma;
  await db.outboxMessage.createMany({
    data: [
      {
        kind: 'JOB',
        name,
        payload,
        availableAt: new Date(Date.now() + (options.delayMs ?? 0)),
        ...(options.dedupeKey === undefined ? {} : { dedupeKey: `job:${options.dedupeKey}` }),
      },
    ],
    skipDuplicates: true,
  });
}

export interface EmitEventInput<TType extends IntegrationEventType> {
  readonly type: TType;
  readonly payload: IntegrationEventPayload<TType>;
  /** Same key, same event: a retried emission never produces a second one. */
  readonly idempotencyKey: string;
  readonly source: ActionSource;
}

/**
 * Record an integration event. Call it with the transaction handle so the
 * event exists if and only if the decision it describes committed.
 * Throws on a payload that does not match its contract: that is a programming
 * error and must fail the transaction, not ship a malformed event.
 */
export async function emitIntegrationEvent<TType extends IntegrationEventType>(
  db: Db,
  event: EmitEventInput<TType>,
): Promise<void> {
  const payload = validateEventPayload(event.type, event.payload);
  await db.outboxMessage.createMany({
    data: [
      {
        kind: 'EVENT',
        name: event.type,
        version: EVENT_VERSIONS[event.type],
        payload,
        source: event.source,
        dedupeKey: `event:${event.idempotencyKey}`,
      },
    ],
    skipDuplicates: true,
  });
}
