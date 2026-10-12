import { randomBytes } from 'node:crypto';

import {
  LINK_RELAY_MIN_CLAIM_BUDGET_MS,
  type CoreOutput,
  type RelayOperation,
  type coreOperations,
  gatewayOperations,
} from '@xenon/contracts';
import { RateLimitError, ValidationError } from '@xenon/core';
import { LinkRelayUnavailableError, type LinkRelayStore } from '@xenon/jobs';
import type { Logger } from '@xenon/logger';

import type { z } from 'zod';

/**
 * Core's side of the Xenon Link relay.
 *
 * `relay.pull` is a long-poll: Link asks for pending worker gateway requests
 * and Core holds the call open (polling Redis without blocking commands, so the
 * shared connection is never stalled) until work arrives, `waitMs` passes or
 * the client goes away. `relay.complete` stores Link's result for the worker.
 * Core never sees `LINK_GATEWAY_SECRET`: it moves signed envelopes, it cannot
 * mint them.
 */

export const MAX_CONCURRENT_PULLS = 2;
export const RELAY_POLL_INTERVAL_MS = 200;

export interface RelayContext {
  /** Aborted when the client disconnects or `relay.close()` runs. */
  readonly signal: AbortSignal;
}

export type RelayHandlers = {
  readonly [TOp in RelayOperation]: (
    input: z.output<(typeof coreOperations)[TOp]['input']>,
    context: RelayContext,
  ) => Promise<CoreOutput<TOp>>;
};

export interface RelayOperationsDeps {
  readonly store: LinkRelayStore;
  readonly logger: Logger;
  /** Pulls held open at once in this process. Default 2. */
  readonly maxConcurrentPulls?: number;
  /** Delay between claim attempts while waiting. Default 200 ms. */
  readonly pollIntervalMs?: number;
  /** Monotonic clock. Default `performance.now`. */
  readonly now?: () => number;
  /** Sleep that resolves early when the signal aborts. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly newLease?: () => string;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

export function createRelayOperations(deps: RelayOperationsDeps): {
  readonly handlers: RelayHandlers;
  close(): void;
} {
  const maxPulls = deps.maxConcurrentPulls ?? MAX_CONCURRENT_PULLS;
  const pollIntervalMs = deps.pollIntervalMs ?? RELAY_POLL_INTERVAL_MS;
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? abortableSleep;
  const newLease = deps.newLease ?? (() => randomBytes(16).toString('hex'));
  const closing = new AbortController();
  let activePulls = 0;

  function warnIfUnavailable(error: unknown, op: RelayOperation): void {
    if (error instanceof LinkRelayUnavailableError) {
      deps.logger.warn({ op, err: error }, 'Link relay store unavailable');
    }
  }

  const handlers: RelayHandlers = {
    'relay.pull': async (input, context) => {
      if (activePulls >= maxPulls) throw new RateLimitError(1);
      activePulls += 1;
      const pullStartedAt = now();
      try {
        await deps.store.markPresence(input.discordReady);
        // A heartbeat (or an unready Link) claims nothing: a request handed to a
        // Link that cannot execute it would only run out its budget.
        if (input.maxRequests === 0 || !input.discordReady)
          return { requests: [], claimElapsedMs: Math.max(0, Math.floor(now() - pullStartedAt)) };

        const signal = AbortSignal.any([context.signal, closing.signal]);
        const lease = newLease();
        const deadline = now() + input.waitMs;
        while (!signal.aborted) {
          // Use the start of this Redis call as the claim boundary. The exact
          // Redis mutation occurs during the awaited call; measuring before it
          // returns conservatively includes Redis latency in Link's debit.
          const claimStartedAt = now();
          const requests = await deps.store.claim({
            max: input.maxRequests,
            lease,
            minBudgetMs: LINK_RELAY_MIN_CLAIM_BUDGET_MS,
          });
          if (requests.length > 0) {
            const claimElapsedMs = Math.max(0, Math.floor(claimStartedAt - pullStartedAt));
            deps.logger.info(
              { op: 'relay.pull', count: requests.length },
              'Relay requests handed to Link',
            );
            return { requests, claimElapsedMs };
          }
          const remaining = deadline - now();
          if (remaining <= 0) break;
          await sleep(Math.min(pollIntervalMs, remaining), signal);
        }
        return { requests: [], claimElapsedMs: Math.max(0, Math.floor(now() - pullStartedAt)) };
      } catch (error) {
        warnIfUnavailable(error, 'relay.pull');
        throw error;
      } finally {
        activePulls -= 1;
      }
    },

    'relay.complete': async (input) => {
      let envelope: unknown = input.response;
      if (input.response.ok) {
        const parsed = gatewayOperations[input.operation].output.safeParse(input.response.data);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          throw new ValidationError({
            response: [`${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'Invalid result'}`],
          });
        }
        envelope = { ok: true, data: parsed.data };
      }
      try {
        const accepted = await deps.store.complete({
          id: input.id,
          lease: input.lease,
          operation: input.operation,
          response: JSON.stringify(envelope),
        });
        return { accepted };
      } catch (error) {
        warnIfUnavailable(error, 'relay.complete');
        throw error;
      }
    },
  };

  return {
    handlers,
    close: () => {
      closing.abort();
    },
  };
}
