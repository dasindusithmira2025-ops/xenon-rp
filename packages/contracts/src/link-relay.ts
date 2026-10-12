import { z } from 'zod';

import {
  GATEWAY_BODY_LIMIT_BYTES,
  GATEWAY_OPERATIONS,
  gatewayErrorSchema,
  type GatewayOperation,
} from './link-gateway';

/**
 * Xenon Link relay — the reverse gateway transport.
 *
 * When Link cannot listen publicly, it pulls the worker's signed gateway
 * requests from Core over outbound HTTPS (`relay.pull`), executes them with its
 * normal handlers and posts the result back (`relay.complete`). Both are
 * ordinary Core operations signed as service `link`. The worker's own
 * signature travels inside each request and is verified by Link, so neither
 * Core nor Redis can mint gateway requests.
 */

/** Max requests one pull may claim; also Link's execution concurrency. */
export const LINK_RELAY_MAX_BATCH = 4;
/** Max long-poll hold at Core. Link's fetch timeout is waitMs + LINK_RELAY_PULL_GRACE_MS. */
export const LINK_RELAY_MAX_WAIT_MS = 20_000;
export const LINK_RELAY_PULL_GRACE_MS = 10_000;
/** Core never hands out a request with less budget than this. */
export const LINK_RELAY_MIN_CLAIM_BUDGET_MS = 3_000;
/** Link never starts a request with less budget than this (measured on receipt). */
export const LINK_RELAY_MIN_EXECUTE_BUDGET_MS = 1_000;
/** TTL of the presence key Core writes on every pull. */
export const LINK_RELAY_PRESENCE_TTL_SECONDS = 30;
/** Link's heartbeat-pull interval while Discord is unready or all slots are busy. Must be << presence TTL. */
export const LINK_RELAY_HEARTBEAT_MS = 5_000;

const hex32 = z.string().regex(/^[0-9a-f]{32}$/);
export const gatewayOperationName = z.enum(
  GATEWAY_OPERATIONS as [GatewayOperation, ...GatewayOperation[]],
);

/** One claimed gateway request as Core hands it to Link. */
export const relayRequestSchema = z.object({
  /** = the worker signature's nonce (x-xenon-service-nonce). */
  id: hex32,
  lease: hex32,
  operation: gatewayOperationName,
  /** Raw JSON body exactly as the worker signed it. */
  body: z.string().min(2).max(GATEWAY_BODY_LIMIT_BYTES),
  /** x-xenon-service-timestamp. */
  timestamp: z.string().regex(/^\d{1,12}$/),
  /** x-xenon-service-signature (HMAC-SHA256 hex). */
  signature: z.string().regex(/^[0-9a-f]{64}$/),
  /** Remaining execution budget at claim time (Redis clock). */
  budgetMs: z.number().int().min(0),
});
export type RelayRequest = z.output<typeof relayRequestSchema>;

export const gatewayResponseSchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }),
  gatewayErrorSchema,
]);

export const linkRelayOperations = {
  'relay.pull': {
    input: z.object({
      maxRequests: z.number().int().min(0).max(LINK_RELAY_MAX_BATCH),
      waitMs: z.number().int().min(0).max(LINK_RELAY_MAX_WAIT_MS),
      discordReady: z.boolean(),
    }),
    output: z.object({
      requests: z.array(relayRequestSchema).max(LINK_RELAY_MAX_BATCH),
      /** Core monotonic ms from pull handler entry until just before the winning claim call. */
      claimElapsedMs: z.number().int().min(0),
    }),
  },
  'relay.complete': {
    input: z.object({
      id: hex32,
      lease: hex32,
      operation: gatewayOperationName,
      response: gatewayResponseSchema,
    }),
    /** false: unknown/expired/abandoned/lease or operation mismatch. Not an error. */
    output: z.object({ accepted: z.boolean() }),
  },
} as const;
export type RelayOperation = keyof typeof linkRelayOperations;
export const RELAY_OPERATIONS = Object.keys(linkRelayOperations) as RelayOperation[];
export function isRelayOperation(name: string): name is RelayOperation {
  return Object.hasOwn(linkRelayOperations, name);
}
