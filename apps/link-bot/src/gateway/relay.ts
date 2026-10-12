import {
  LINK_RELAY_HEARTBEAT_MS,
  LINK_RELAY_MAX_BATCH,
  LINK_RELAY_MAX_WAIT_MS,
  LINK_RELAY_MIN_EXECUTE_BUDGET_MS,
  LINK_RELAY_PULL_GRACE_MS,
  SERVICE_HEADER,
  SERVICE_NONCE_HEADER,
  SERVICE_SIGNATURE_HEADER,
  SERVICE_TIMESTAMP_HEADER,
  type RelayRequest,
} from '@xenon/contracts';
import type { Logger } from '@xenon/logger';

import { abortableSleep, jitteredBackoff } from '../sleep';

import type { CoreCall, CoreResult } from '../core-client';
import type { GatewayExecutor } from './execute';

/**
 * The relay: Link's outbound replacement for the gateway HTTP server.
 *
 * Link cannot listen publicly in the single-instance deployment, so it pulls
 * the worker's signed gateway requests from Core (`relay.pull`, a long-poll),
 * runs each through the same executor as the HTTP server (which re-verifies the
 * worker's signature and replay nonce) and posts the result back
 * (`relay.complete`). The loop never throws and never touches the Discord
 * client: a Core outage only means Discord effects wait in the worker's queue.
 *
 * Bodies, signatures and results are never logged.
 */

export const RELAY_BACKOFF = { initialMs: 1_000, maxMs: 30_000 } as const;
export const RELAY_DRAIN_TIMEOUT_MS = 10_000;
export const RELAY_COMPLETE_ATTEMPTS = 3;

const COMPLETE_RETRY_DELAYS_MS = [250, 1_000] as const;
/** Extra time past the request's budget in which a result may still be posted. */
const COMPLETE_SLACK_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;
const COMPLETE_TIMEOUT_MS = 5_000;

export interface GatewayRelayOptions {
  readonly core: CoreCall;
  readonly execute: GatewayExecutor;
  readonly isDiscordReady: () => boolean;
  readonly logger: Logger;
  readonly concurrency?: number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  readonly random?: () => number;
}

export interface GatewayRelay {
  stop(): Promise<void>;
}

interface PullInput {
  maxRequests: number;
  waitMs: number;
  discordReady: boolean;
}

export function startGatewayRelay(options: GatewayRelayOptions): GatewayRelay {
  const { core, execute, logger } = options;
  const concurrency = options.concurrency ?? LINK_RELAY_MAX_BATCH;
  const sleep = options.sleep ?? abortableSleep;
  const now = options.now ?? (() => performance.now());
  const random = options.random ?? Math.random;

  const controller = new AbortController();
  const { signal } = controller;
  /** Result posts must outlive `stop()`'s abort so draining work can still report. */
  const neverAborted = new AbortController().signal;
  const inflight = new Set<Promise<void>>();

  let connected = false;
  let failing = false;
  let lastFailureCode: string | null = null;
  let attempt = 0;

  function noteFailure(result: Extract<CoreResult<unknown>, { ok: false }>): number {
    const { code, retryAfterSeconds } = result.error;
    if (!failing || (code === 'UNAUTHENTICATED' && lastFailureCode !== code)) {
      if (code === 'UNAUTHENTICATED') {
        logger.error({ code }, 'Relay rejected by Core; check LINK_CORE_SECRET');
      } else {
        logger.warn({ code }, 'Relay cannot reach Core; retrying');
      }
    }
    failing = true;
    connected = false;
    lastFailureCode = code;
    if (code === 'RATE_LIMITED') return (retryAfterSeconds ?? 1) * 1_000;
    const delay = jitteredBackoff(attempt, RELAY_BACKOFF, random);
    attempt += 1;
    return delay;
  }

  /** One `relay.pull`. Subtract wall time spent in the pull from the claim-time budget. */
  async function pull(input: PullInput, timeoutMs: number): Promise<boolean> {
    const pullStartedAt = now();
    const result = await core('relay.pull', input, { timeoutMs, signal });
    if (!result.ok) {
      if (signal.aborted) return false;
      await sleep(noteFailure(result), signal);
      return false;
    }
    // Core reports how long it spent waiting before it claimed this batch.
    // Debit only client-observed time after claim, so fresh work arriving late
    // in a long-poll keeps its full remaining budget.
    const elapsedMs = Math.max(0, now() - pullStartedAt);
    const responseDelayMs = Math.max(0, elapsedMs - result.data.claimElapsedMs);
    if (!connected) logger.info('Relay connected');
    connected = true;
    failing = false;
    lastFailureCode = null;
    attempt = 0;
    for (const request of result.data.requests) {
      const budgetMs = Math.max(0, request.budgetMs - responseDelayMs);
      track({ ...request, budgetMs });
    }
    return true;
  }

  function track(request: RelayRequest): void {
    const run = runOne(request)
      .catch((error: unknown) => {
        // Never pass an untrusted/dependency error object to pino: Discord HTTP
        // errors may carry requestBody including DM/message contents.
        logger.error(
          {
            errorName: error instanceof Error ? error.name : 'UnknownError',
            operation: request.operation,
          },
          'Relay request crashed',
        );
      })
      .finally(() => {
        inflight.delete(run);
      });
    inflight.add(run);
  }

  async function runOne(request: RelayRequest): Promise<void> {
    const startedAt = now();
    if (request.budgetMs < LINK_RELAY_MIN_EXECUTE_BUDGET_MS) {
      logger.debug({ operation: request.operation }, 'Dropped stale relay request');
      return;
    }

    const headers: Readonly<Record<string, string>> = {
      [SERVICE_HEADER]: 'worker',
      [SERVICE_SIGNATURE_HEADER]: request.signature,
      [SERVICE_TIMESTAMP_HEADER]: request.timestamp,
      [SERVICE_NONCE_HEADER]: request.id,
    };
    const execution = await execute({
      operation: request.operation,
      body: request.body,
      header: (name) => headers[name],
    });
    logger.debug(
      {
        operation: request.operation,
        ok: execution.response.ok,
        ms: Math.round(now() - startedAt),
      },
      'Relay request executed',
    );

    for (let tryNumber = 0; tryNumber < RELAY_COMPLETE_ATTEMPTS; tryNumber += 1) {
      if (tryNumber > 0) {
        await sleep(COMPLETE_RETRY_DELAYS_MS[tryNumber - 1] ?? 1_000, neverAborted);
        if (now() - startedAt >= request.budgetMs + COMPLETE_SLACK_MS) break;
      }
      const result = await core(
        'relay.complete',
        {
          id: request.id,
          lease: request.lease,
          operation: request.operation,
          response: execution.response,
        },
        { timeoutMs: COMPLETE_TIMEOUT_MS, signal: neverAborted },
      ).catch(() => null);
      if (result?.ok && result.data.accepted) return;
      if (result?.ok) {
        if (!result.data.accepted) {
          logger.debug({ operation: request.operation }, 'Relay result discarded by Core');
        }
        return;
      }
    }
    logger.warn({ operation: request.operation }, 'Relay result could not be delivered');
  }

  async function loop(): Promise<void> {
    while (!signal.aborted) {
      try {
        if (!options.isDiscordReady()) {
          const ok = await pull(
            { maxRequests: 0, waitMs: 0, discordReady: false },
            HEARTBEAT_TIMEOUT_MS,
          );
          if (ok) await sleep(LINK_RELAY_HEARTBEAT_MS, signal);
          continue;
        }

        const free = concurrency - inflight.size;
        if (free <= 0) {
          const waitStarted = now();
          const wake = new AbortController();
          await Promise.race([
            ...inflight,
            sleep(LINK_RELAY_HEARTBEAT_MS, AbortSignal.any([signal, wake.signal])),
          ]);
          wake.abort();
          if (now() - waitStarted >= LINK_RELAY_HEARTBEAT_MS) {
            await pull({ maxRequests: 0, waitMs: 0, discordReady: true }, HEARTBEAT_TIMEOUT_MS);
          }
          continue;
        }

        await pull(
          {
            maxRequests: Math.min(free, LINK_RELAY_MAX_BATCH),
            waitMs: LINK_RELAY_MAX_WAIT_MS,
            discordReady: true,
          },
          LINK_RELAY_MAX_WAIT_MS + LINK_RELAY_PULL_GRACE_MS,
        );
      } catch (error) {
        logger.error(
          { errorName: error instanceof Error ? error.name : 'UnknownError' },
          'Relay loop error',
        );
        await sleep(jitteredBackoff(attempt, RELAY_BACKOFF, random), signal);
        attempt += 1;
      }
    }
  }

  logger.info({ concurrency }, 'Relay started');
  const running = loop();

  return {
    async stop(): Promise<void> {
      controller.abort();
      const drain = new AbortController();
      await Promise.race([
        Promise.allSettled([running, ...inflight]),
        sleep(RELAY_DRAIN_TIMEOUT_MS, drain.signal),
      ]);
      drain.abort();
      logger.info('Relay stopped');
    },
  };
}
