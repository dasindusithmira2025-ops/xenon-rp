import { Worker } from 'bullmq';
import { QUEUE_NAME, queueRedis } from '@xenon/jobs';
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
let worker = null;
export function startWorker() {
  worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const name = job.name;
      const handler = handlers[name];
      if (handler === undefined) {
        // A job whose name no longer exists in the catalogue. Failing it
        // loudly is better than silently dropping work somebody queued.
        throw new Error(`No handler for job ${job.name}`);
      }
      const started = Date.now();
      await handler(job.data);
      logger.debug({ job: job.name, id: job.id, ms: Date.now() - started }, 'Job done');
    },
    { connection: queueRedis(), concurrency: CONCURRENCY },
  );
  worker.on('failed', (job, error) => {
    const attempts = job?.attemptsMade ?? 0;
    const max = job?.opts.attempts ?? 1;
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
export async function stopWorker() {
  await worker?.close();
  worker = null;
}
//# sourceMappingURL=index.js.map
