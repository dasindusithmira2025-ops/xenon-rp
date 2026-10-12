import { Queue, type JobsOptions } from 'bullmq';

import { type JobName, type JobPayloads, QUEUE_NAME, jobIdFor, retryPolicy } from './contracts';
import { queueRedis } from './redis';

let queueInstance: Queue | undefined;

/** The shared queue handle. Created on first use so imports stay side-effect free. */
export function jobQueue(): Queue {
  queueInstance ??= new Queue(QUEUE_NAME, {
    connection: queueRedis(),
    defaultJobOptions: {
      removeOnComplete: { count: 1_000, age: 60 * 60 * 24 },
      // Failures are kept far longer: they are the operational record of what
      // Discord or FXServer refused, and the health page reads them.
      removeOnFail: { count: 5_000, age: 60 * 60 * 24 * 14 },
    },
  });
  return queueInstance;
}

export interface EnqueueOptions {
  /** Delay before the job becomes eligible to run. */
  readonly delayMs?: number;
  /** Repeat pattern for scheduled sweeps, as a cron expression. */
  readonly repeatCron?: string;
  /** Higher runs first. Defaults to normal priority. */
  readonly priority?: number;
  /**
   * BullMQ job id when the catalogue does not fix one. The outbox relay passes
   * one derived from the outbox row so a re-dispatch after a crash collapses.
   * Must not contain `:`.
   */
  readonly jobId?: string;
}

/**
 * Put a job straight onto the BullMQ queue.
 *
 * Throws when Redis is unreachable. Only the outbox relay calls this: every
 * domain side effect is recorded with `enqueueDurable` inside the transaction
 * that decided it, and the relay moves it here once it has committed.
 */
export async function enqueue<TName extends JobName>(
  name: TName,
  payload: JobPayloads[TName],
  options: EnqueueOptions = {},
): Promise<string | undefined> {
  const policy = retryPolicy[name];

  const jobOptions: JobsOptions = {
    attempts: policy.attempts,
    backoff: { type: 'exponential', delay: policy.backoffMs },
    jobId: jobIdFor(name, payload) ?? options.jobId,
    ...(options.delayMs === undefined ? {} : { delay: options.delayMs }),
    ...(options.priority === undefined ? {} : { priority: options.priority }),
    ...(options.repeatCron === undefined ? {} : { repeat: { pattern: options.repeatCron } }),
  };

  const job = await jobQueue().add(name, payload, jobOptions);
  return job.id;
}

export interface QueueDepth {
  readonly waiting: number;
  readonly active: number;
  readonly delayed: number;
  readonly failed: number;
  readonly completed: number;
}

/** Queue counters for the health screen. */
export async function queueDepth(): Promise<QueueDepth> {
  const counts = await jobQueue().getJobCounts(
    'waiting',
    'active',
    'delayed',
    'failed',
    'completed',
  );

  return {
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    delayed: counts.delayed ?? 0,
    failed: counts.failed ?? 0,
    completed: counts.completed ?? 0,
  };
}

/** Close the queue handle. Used by graceful shutdown and by tests. */
export async function closeQueue(): Promise<void> {
  await queueInstance?.close();
  queueInstance = undefined;
}
