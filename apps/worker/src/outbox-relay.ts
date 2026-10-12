import { type IntegrationEventType, SUBSCRIPTIONS } from '@xenon/contracts';
import type { OutboxMessage, PrismaClient } from '@xenon/database';
import { type JobName, type JobPayloads, retryPolicy } from '@xenon/jobs';
import type { Logger } from '@xenon/logger';

/**
 * The outbox relay: moves committed side effects from Postgres onto BullMQ.
 *
 * Domain services write `OutboxMessage` rows inside the transaction that made
 * the decision. This loop claims due rows with `FOR UPDATE SKIP LOCKED`, so
 * any number of worker replicas can run it without dispatching a row twice,
 * and marks each one dispatched in the same transaction that claimed it.
 *
 * A crash between the BullMQ add and the commit re-dispatches the row later.
 * That is safe because every job gets a deterministic BullMQ id - the
 * catalogue's own id, or one derived from the outbox row - so the second add
 * collapses into the first. Redis being down only delays dispatch: the row
 * stays pending with exponential backoff and the health page shows its age.
 */

/** Enqueue onto BullMQ. `@xenon/jobs` `enqueue`, injected for tests. */
export type RelayEnqueue = <TName extends JobName>(
  name: TName,
  payload: JobPayloads[TName],
  options: { readonly jobId: string },
) => Promise<unknown>;

export interface RelayDeps {
  readonly db: PrismaClient;
  readonly enqueue: RelayEnqueue;
  readonly logger: Logger;
  readonly batchSize?: number;
  /** Bound on one BullMQ add; a hung Redis must not hold the claim open. */
  readonly enqueueTimeoutMs?: number;
}

export interface RelayResult {
  readonly claimed: number;
  readonly dispatched: number;
  readonly failed: number;
}

const DEFAULT_BATCH = 50;
const DEFAULT_ENQUEUE_TIMEOUT_MS = 5_000;
const MAX_BACKOFF_MS = 10 * 60_000;
const MAX_ERROR_LENGTH = 500;

class RelayTimeoutError extends Error {}

function isJobName(name: string): name is JobName {
  return Object.hasOwn(retryPolicy, name);
}

function isEventType(name: string): name is IntegrationEventType {
  return Object.hasOwn(SUBSCRIPTIONS, name);
}

/** Error text for the row: bounded, and never a URL that could carry credentials. */
function describe(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error';
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]').slice(0, MAX_ERROR_LENGTH);
}

/** 2^attempts seconds, capped at ten minutes. */
export function relayBackoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 1000, MAX_BACKOFF_MS);
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    timeout.reject(new RelayTimeoutError(`Queue add timed out after ${String(ms)}ms`));
  }, ms);
  try {
    return await Promise.race([work, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Dispatch one row. Returns a note for `lastError` when the row is finished
 * without being dispatched anywhere (an unknown name: retrying cannot help).
 */
async function dispatch(
  row: OutboxMessage,
  enqueue: RelayEnqueue,
  timeoutMs: number,
): Promise<string | null> {
  if (row.kind === 'JOB') {
    if (!isJobName(row.name)) return `Unknown job name ${row.name}; not dispatched`;
    // The payload was typed by `enqueueDurable` when it was written.
    const payload = row.payload as JobPayloads[typeof row.name];
    await withTimeout(enqueue(row.name, payload, { jobId: `outbox~${row.id}` }), timeoutMs);
    return null;
  }

  if (!isEventType(row.name)) return `Unknown event type ${row.name}; not dispatched`;
  for (const subscriber of SUBSCRIPTIONS[row.name]) {
    await withTimeout(
      enqueue(
        'integration.event.deliver',
        { outboxId: row.id, subscriber },
        { jobId: `event~${row.id}~${subscriber}` },
      ),
      timeoutMs,
    );
  }
  return null;
}

/** Claim and dispatch one batch of due rows. */
export async function relayOutbox(deps: RelayDeps): Promise<RelayResult> {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH;
  const timeoutMs = deps.enqueueTimeoutMs ?? DEFAULT_ENQUEUE_TIMEOUT_MS;

  return deps.db.$transaction(
    async (tx) => {
      const claimed = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM outbox_messages
        WHERE "dispatchedAt" IS NULL AND "availableAt" <= now()
        ORDER BY "availableAt"
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED`;
      if (claimed.length === 0) return { claimed: 0, dispatched: 0, failed: 0 };

      const rows = await tx.outboxMessage.findMany({
        where: { id: { in: claimed.map((row) => row.id) } },
        orderBy: { availableAt: 'asc' },
      });

      let dispatched = 0;
      let failed = 0;
      for (const row of rows) {
        try {
          const note = await dispatch(row, deps.enqueue, timeoutMs);
          await tx.outboxMessage.update({
            where: { id: row.id },
            data: { dispatchedAt: new Date(), ...(note === null ? {} : { lastError: note }) },
          });
          if (note === null) dispatched += 1;
          else deps.logger.error({ outboxId: row.id, name: row.name }, note);
        } catch (error) {
          failed += 1;
          const attempts = row.attempts + 1;
          await tx.outboxMessage.update({
            where: { id: row.id },
            data: {
              attempts,
              lastError: describe(error),
              availableAt: new Date(Date.now() + relayBackoffMs(attempts)),
            },
          });
          deps.logger.warn(
            { outboxId: row.id, name: row.name, attempts, err: error },
            'Outbox dispatch failed; will retry',
          );
        }
      }
      return { claimed: rows.length, dispatched, failed };
    },
    // Each add is bounded by `timeoutMs`; the claim must outlive a full batch.
    { maxWait: 10_000, timeout: batchSize * timeoutMs + 10_000 },
  );
}
