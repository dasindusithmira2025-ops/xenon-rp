import {
  LINK_RELAY_PRESENCE_TTL_SECONDS,
  relayRequestSchema,
  type GatewayOperation,
  type RelayRequest,
} from '@xenon/contracts';
import { IntegrationError } from '@xenon/core';

import type { Redis } from 'ioredis';

/**
 * Redis model and store for the Xenon Link reverse gateway transport.
 *
 * The worker enqueues signed gateway requests; Core claims them on behalf of a
 * polling Link and stores Link's result; the worker reads the result. Each
 * request runs at most once: the claim is an atomic `pending -> claimed`
 * transition and nothing is ever redelivered.
 *
 * All deadlines use Redis's own clock (`TIME` inside the scripts), so no wall
 * clock is compared across hosts. Request keys are built inside the claim and
 * abandon scripts from a prefix, so this requires a single-primary Redis, not
 * Cluster (BullMQ on the same Redis has the same constraint).
 *
 * Request hash `relay:link:req:<id>`: `op`, `body`, `ts`, `sig`, `exp`
 * (expiresAt, Redis ms), `state` (`pending|claimed|done|expired`), `lease`
 * (when claimed), `res` (raw JSON GatewayResponse, when done). The hash
 * expires `ttlMs + LINK_RELAY_GRACE_MS` after enqueue.
 */

export const linkRelayKeys = {
  /** LIST of ids; LPUSH enqueue, RPOP claim (FIFO). */
  pending: 'relay:link:pending',
  /** STRING 'ready' | 'unready', EX LINK_RELAY_PRESENCE_TTL_SECONDS. */
  presence: 'relay:link:presence',
  requestPrefix: 'relay:link:req:',
  request: (id: string) => `relay:link:req:${id}`,
} as const;

export const LINK_RELAY_MAX_PENDING = 256;
/** Hash TTL = ttlMs + grace. */
export const LINK_RELAY_GRACE_MS = 60_000;
/** Per Redis call; the shared client queues commands while disconnected. */
export const LINK_RELAY_STORE_TIMEOUT_MS = 1_000;
/** Max ids popped per claim call. */
export const LINK_RELAY_CLAIM_SCAN_LIMIT = 64;

export interface LinkRelayEnvelope {
  readonly id: string;
  readonly operation: GatewayOperation;
  readonly body: string;
  readonly timestamp: string;
  readonly signature: string;
}
export type LinkRelayEnqueueOutcome = 'queued' | 'offline' | 'not_ready' | 'full' | 'duplicate';
export type LinkRelayRead =
  | { readonly state: 'missing' | 'pending' | 'claimed' | 'expired' }
  | { readonly state: 'done'; readonly response: string }; // raw JSON GatewayResponse
export interface LinkRelayPresence {
  readonly state: 'ready' | 'unready' | 'absent';
  readonly pending: number;
}

export interface LinkRelayStore {
  /** Worker. Fails fast: presence absent -> 'offline', 'unready' -> 'not_ready'. */
  enqueue(envelope: LinkRelayEnvelope, ttlMs: number): Promise<LinkRelayEnqueueOutcome>;
  /** Worker: poll one request. */
  read(id: string): Promise<LinkRelayRead>;
  /** Worker: remove from pending + delete; returns the state *before* removal (incl. response if done). */
  abandon(id: string): Promise<LinkRelayRead>;
  /** Worker probe. */
  presence(): Promise<LinkRelayPresence>;
  /** Core: on every pull. */
  markPresence(discordReady: boolean): Promise<void>;
  /** Core: atomically claim <= max pending requests with >= minBudgetMs left; expired ones are marked 'expired'. */
  claim(options: {
    readonly max: number;
    readonly lease: string;
    readonly minBudgetMs: number;
  }): Promise<RelayRequest[]>;
  /** Core: claimed -> done iff lease and operation match; idempotent for the same lease. */
  complete(input: {
    readonly id: string;
    readonly lease: string;
    readonly operation: GatewayOperation;
    readonly response: string;
  }): Promise<boolean>;
}

/** Redis failed or exceeded LINK_RELAY_STORE_TIMEOUT_MS. 502 at Core, retryable everywhere. */
export class LinkRelayUnavailableError extends IntegrationError {
  constructor(cause?: unknown) {
    super('link-relay', 'The Link relay store is unavailable', { retryable: true, cause });
  }
}

export type LinkRelayRedis = Pick<Redis, 'eval' | 'hmget' | 'get' | 'set' | 'llen'>;

const NOW_LUA = `local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)`;

/** KEYS: pending, req, presence. ARGV: id, op, body, ts, sig, ttlMs, maxPending, graceMs. */
export const ENQUEUE_SCRIPT = `
local presence = redis.call('GET', KEYS[3])
if not presence then return 'offline' end
if presence ~= 'ready' then return 'not_ready' end
if redis.call('EXISTS', KEYS[2]) == 1 then return 'duplicate' end
if redis.call('LLEN', KEYS[1]) >= tonumber(ARGV[7]) then return 'full' end
${NOW_LUA}
local ttl = tonumber(ARGV[6])
redis.call('HSET', KEYS[2], 'op', ARGV[2], 'body', ARGV[3], 'ts', ARGV[4], 'sig', ARGV[5], 'exp', now + ttl, 'state', 'pending')
redis.call('PEXPIRE', KEYS[2], ttl + tonumber(ARGV[8]))
redis.call('LPUSH', KEYS[1], ARGV[1])
return 'queued'
`;

/** KEYS: pending. ARGV: max, lease, minBudgetMs, reqPrefix, scanLimit. Returns flat 6-tuples. */
export const CLAIM_SCRIPT = `
${NOW_LUA}
local max = tonumber(ARGV[1])
local minBudget = tonumber(ARGV[3])
local scanLimit = tonumber(ARGV[5])
local out = {}
local claimed = 0
local scanned = 0
while claimed < max and scanned < scanLimit do
  local id = redis.call('RPOP', KEYS[1])
  if not id then break end
  scanned = scanned + 1
  local key = ARGV[4] .. id
  local f = redis.call('HMGET', key, 'state', 'exp', 'op', 'body', 'ts', 'sig')
  if f[1] == 'pending' then
    local left = tonumber(f[2]) - now
    if left >= minBudget then
      redis.call('HSET', key, 'state', 'claimed', 'lease', ARGV[2])
      out[#out + 1] = id
      out[#out + 1] = f[3]
      out[#out + 1] = f[4]
      out[#out + 1] = f[5]
      out[#out + 1] = f[6]
      out[#out + 1] = left
      claimed = claimed + 1
    else
      redis.call('HSET', key, 'state', 'expired')
    end
  end
end
return out
`;

/** KEYS: req. ARGV: lease, op, response. */
export const COMPLETE_SCRIPT = `
local f = redis.call('HMGET', KEYS[1], 'state', 'lease', 'op')
if f[2] ~= ARGV[1] or f[3] ~= ARGV[2] then return 0 end
if f[1] == 'claimed' then
  redis.call('HSET', KEYS[1], 'state', 'done', 'res', ARGV[3])
  return 1
end
if f[1] == 'done' then return 1 end
return 0
`;

/** KEYS: pending, req. ARGV: id. */
export const ABANDON_SCRIPT = `
local f = redis.call('HMGET', KEYS[2], 'state', 'res')
redis.call('LREM', KEYS[1], 1, ARGV[1])
redis.call('DEL', KEYS[2])
if not f[1] then return {'missing'} end
if f[2] then return {f[1], f[2]} end
return {f[1]}
`;

const ENQUEUE_OUTCOMES: Record<LinkRelayEnqueueOutcome, true> = {
  queued: true,
  offline: true,
  not_ready: true,
  full: true,
  duplicate: true,
};
const PLAIN_STATES: Record<'pending' | 'claimed' | 'expired', true> = {
  pending: true,
  claimed: true,
  expired: true,
};

function isOwnKey(table: object, value: unknown): value is string {
  return typeof value === 'string' && Object.hasOwn(table, value);
}

function toRead(state: unknown, response: unknown): LinkRelayRead {
  if (state === 'done' && typeof response === 'string') return { state: 'done', response };
  if (isOwnKey(PLAIN_STATES, state)) return { state: state as 'pending' | 'claimed' | 'expired' };
  return { state: 'missing' };
}

const TUPLE = 6;

function parseClaim(reply: unknown, lease: string): RelayRequest[] {
  if (!Array.isArray(reply) || reply.length % TUPLE !== 0) {
    throw new Error('claim reply is not a list of 6-tuples');
  }
  const requests: RelayRequest[] = [];
  for (let at = 0; at < reply.length; at += TUPLE) {
    const [id, operation, body, timestamp, signature, budgetMs] = reply.slice(at, at + TUPLE) as [
      unknown,
      unknown,
      unknown,
      unknown,
      unknown,
      unknown,
    ];
    // A malformed record was already marked claimed in Redis; dropping it here
    // lets the worker's own timeout deal with it rather than failing the batch.
    const parsed = relayRequestSchema.safeParse({
      id,
      lease,
      operation,
      body,
      timestamp,
      signature,
      budgetMs: Number(budgetMs),
    });
    if (parsed.success) requests.push(parsed.data);
  }
  return requests;
}

export function createRedisLinkRelayStore(
  client: LinkRelayRedis,
  options: { readonly timeoutMs?: number } = {},
): LinkRelayStore {
  const timeoutMs = options.timeoutMs ?? LINK_RELAY_STORE_TIMEOUT_MS;

  /** Bound one Redis interaction (including reply parsing) and normalise its failure. */
  async function guarded<T>(run: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    // Promise.withResolvers is outside this package's `lib` target.
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Redis call exceeded ${timeoutMs} ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([run(), timeout]);
    } catch (error) {
      throw new LinkRelayUnavailableError(error);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    enqueue: (envelope, ttlMs) =>
      guarded(async () => {
        const reply = await client.eval(
          ENQUEUE_SCRIPT,
          3,
          linkRelayKeys.pending,
          linkRelayKeys.request(envelope.id),
          linkRelayKeys.presence,
          envelope.id,
          envelope.operation,
          envelope.body,
          envelope.timestamp,
          envelope.signature,
          ttlMs,
          LINK_RELAY_MAX_PENDING,
          LINK_RELAY_GRACE_MS,
        );
        if (!isOwnKey(ENQUEUE_OUTCOMES, reply)) throw new Error('unexpected enqueue reply');
        return reply as LinkRelayEnqueueOutcome;
      }),

    read: (id) =>
      guarded(async () => {
        const [state, response] = await client.hmget(linkRelayKeys.request(id), 'state', 'res');
        return toRead(state, response);
      }),

    abandon: (id) =>
      guarded(async () => {
        const reply = await client.eval(
          ABANDON_SCRIPT,
          2,
          linkRelayKeys.pending,
          linkRelayKeys.request(id),
          id,
        );
        if (!Array.isArray(reply)) throw new Error('unexpected abandon reply');
        return toRead(reply[0], reply[1]);
      }),

    presence: () =>
      guarded(async () => {
        const [value, pending] = await Promise.all([
          client.get(linkRelayKeys.presence),
          client.llen(linkRelayKeys.pending),
        ]);
        const state = value === null ? 'absent' : value === 'ready' ? 'ready' : 'unready';
        return { state, pending };
      }),

    markPresence: (discordReady) =>
      guarded(async () => {
        await client.set(
          linkRelayKeys.presence,
          discordReady ? 'ready' : 'unready',
          'EX',
          LINK_RELAY_PRESENCE_TTL_SECONDS,
        );
      }),

    claim: ({ max, lease, minBudgetMs }) => {
      if (max <= 0) return Promise.resolve([]);
      return guarded(async () => {
        const reply = await client.eval(
          CLAIM_SCRIPT,
          1,
          linkRelayKeys.pending,
          max,
          lease,
          minBudgetMs,
          linkRelayKeys.requestPrefix,
          LINK_RELAY_CLAIM_SCAN_LIMIT,
        );
        return parseClaim(reply, lease);
      });
    },

    complete: ({ id, lease, operation, response }) =>
      guarded(async () => {
        const reply = await client.eval(
          COMPLETE_SCRIPT,
          1,
          linkRelayKeys.request(id),
          lease,
          operation,
          response,
        );
        return reply === 1;
      }),
  };
}
