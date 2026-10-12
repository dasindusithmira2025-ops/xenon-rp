import { UnrecoverableError, Worker } from 'bullmq';

import { type JobName, type JobPayloads, QUEUE_NAME, queueRedis } from '@xenon/jobs';
import type { Logger } from '@xenon/logger';

import { isPermanentFailure } from './gateway-client';

import type { Handlers } from './handlers';

/**
 * The job consumer.
 *
 * One worker over one queue. Concurrency is modest on purpose: most jobs end
 * in a Discord API call through Link, and Discord rate-limits per route.
 * BullMQ applies the retry policy each job was enqueued with, so a handler
 * only succeeds or throws; a permanent failure is converted to
 * `UnrecoverableError` so it is recorded once instead of retried.
 */
const CONCURRENCY = 4;

export function startQueueWorker(handlers: Handlers, logger: Logger): Worker {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (!Object.hasOwn(handlers, job.name)) {
        // A job whose name left the catalogue. Failing it loudly beats
        // silently dropping work somebody queued.
        throw new UnrecoverableError(`No handler for job ${job.name}`);
      }
      // Checked above; BullMQ hands back the payload the catalogue typed.
      const handler = handlers[job.name as JobName] as (
        payload: JobPayloads[JobName],
      ) => Promise<void>;

      const started = Date.now();
      try {
        await handler(job.data as JobPayloads[JobName]);
      } catch (error) {
        if (isPermanentFailure(error)) {
          throw new UnrecoverableError(
            error instanceof Error ? error.message : 'Permanent failure',
          );
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
    const context = { job: job?.name, id: job?.id, attempts, max, err: error };

    if (error instanceof UnrecoverableError) {
      logger.error(context, 'Job failed permanently and will not retry');
    } else if (attempts < max) {
      logger.warn(context, 'Job failed, will retry');
    } else {
      logger.error(
        context,
        'Job exhausted its retries. Canonical state in Postgres is unaffected; this side effect was not delivered.',
      );
    }
  });

  worker.on('error', (error) => {
    logger.error({ err: error }, 'Worker error');
  });

  logger.info({ concurrency: CONCURRENCY }, 'Job worker started');
  return worker;
}
