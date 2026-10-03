import { UnrecoverableError, Worker } from 'bullmq';

import { IntegrationError } from '@xenon/core';
import { type JobName, type JobPayloads, QUEUE_NAME, queueRedis } from '@xenon/jobs';

import { logger } from '../runtime';

import { handlers } from './handlers';

/**
 * The job worker.
 *
 * One worker over one queue. Concurrency is modest on purpose: almost
 * everything here is a Discord API call, and Discord rate-limits per route -
 * running twenty in parallel earns a 429 rather than finishing sooner.
 *
 * BullMQ handles retry and backoff from the policy each job was enqueued with,
 * so a handler's only job is to succeed or to throw.
 */
const CONCURRENCY = 4;

let worker: Worker | null = null;

export function startWorker(): Worker {
  worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const name = job.name as JobName;
      const handler = handlers[name] as
        ((payload: JobPayloads[JobName]) => Promise<void>) | undefined;

      if (handler === undefined) {
        // A job whose name no longer exists in the catalogue. Failing it
        // loudly is better than silently dropping work somebody queued.
        throw new Error(`No handler for job ${job.name}`);
      }

      const started = Date.now();
      try {
        await handler(job.data as JobPayloads[JobName]);
      } catch (error) {
        if (error instanceof IntegrationError && !error.retryable) {
          throw new UnrecoverableError(error.message);
        }
        throw error;
      }
      logger.debug({ job: job.name, id: job.id, ms: Date.now() - started }, 'Job done');
    },
    { connection: queueRedis(), concurrency: CONCURRENCY },
  );

  worker.on('failed', (job, error) => {
    const attempts = job?.attemptsMade ?? 0;
    const max = job?.opts.attempts ?? 1;

    if (error instanceof UnrecoverableError) {
      logger.error(
        { job: job?.name, id: job?.id, attempts, err: error },
        'Job failed permanently and will not retry. The canonical state in Postgres is unaffected.',
      );
      return;
    }

    // The distinction matters to whoever is reading the logs: a retry is
    // expected operational noise, a final failure is owed work that will not
    // happen without intervention.
    if (attempts < max) {
      logger.warn(
        { job: job?.name, id: job?.id, attempt: attempts, max, err: error },
        'Job failed, will retry',
      );
      return;
    }

    logger.error(
      { job: job?.name, id: job?.id, attempts, err: error },
      'Job failed permanently. The canonical state in Postgres is unaffected; this side effect was not delivered.',
    );
  });

  worker.on('error', (error) => {
    logger.error({ err: error }, 'Worker error');
  });

  logger.info({ concurrency: CONCURRENCY }, 'Job worker started');
  return worker;
}

export async function stopWorker(): Promise<void> {
  await worker?.close();
  worker = null;
}
