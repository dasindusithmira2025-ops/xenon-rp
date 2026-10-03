import { RateLimitError } from '@xenon/core';

import { redis } from './redis';

/**
 * Fixed-window rate limiting in Redis.
 *
 * A fixed window rather than a sliding log: the burst at a window boundary is
 * bounded at 2x, which is acceptable for the things being protected here, and
 * the implementation is two commands instead of a sorted-set scan per request.
 *
 * Redis rather than in-process counters because the web tier runs as several
 * instances, and a per-instance limit is not a limit.
 *
 * ponytail: fixed window; swap for a sliding window if boundary bursts on
 * submission endpoints ever matter in practice.
 */

export interface RateLimitRule {
  /** Stable name, used as the Redis key prefix. */
  readonly name: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}

/**
 * The protected operations and their budgets.
 *
 * Tuned to be invisible to a real person and obstructive to a script: a player
 * writes one application, not forty, and generates one link code, not a
 * hundred.
 */
export const rateLimits = {
  signIn: { name: 'auth:signin', limit: 10, windowSeconds: 300 },
  discordMembershipResync: { name: 'discord:membership-resync', limit: 3, windowSeconds: 300 },
  applicationStart: { name: 'app:start', limit: 10, windowSeconds: 3600 },
  applicationSubmit: { name: 'app:submit', limit: 6, windowSeconds: 3600 },
  applicationAutosave: { name: 'app:autosave', limit: 240, windowSeconds: 300 },
  linkCode: { name: 'fivem:linkcode', limit: 5, windowSeconds: 900 },
  bridgeRedeem: { name: 'fivem:redeem', limit: 20, windowSeconds: 300 },
  bridgeRequest: { name: 'fivem:bridge', limit: 600, windowSeconds: 60 },
  ticketCreate: { name: 'ticket:create', limit: 5, windowSeconds: 3600 },
  ticketReply: { name: 'ticket:reply', limit: 30, windowSeconds: 600 },
  reportCreate: { name: 'report:create', limit: 5, windowSeconds: 3600 },
  appealCreate: { name: 'appeal:create', limit: 3, windowSeconds: 86_400 },
  search: { name: 'search', limit: 120, windowSeconds: 60 },
  upload: { name: 'upload', limit: 40, windowSeconds: 3600 },
  discordSelfRole: { name: 'discord:self-role', limit: 10, windowSeconds: 60 },
  discordTempRoom: { name: 'discord:temp-room', limit: 3, windowSeconds: 300 },
  discordRoomEdit: { name: 'discord:room-edit', limit: 6, windowSeconds: 600 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof rateLimits;

/**
 * Consume one unit from a bucket.
 *
 * Fails open. A Redis outage must not make the whole site unusable, and the
 * things behind these limits are all additionally authorized and audited - the
 * limit is an abuse control, not an authorization boundary.
 */
export async function consumeRateLimit(
  rule: RateLimitRule,
  identity: string,
): Promise<RateLimitResult> {
  const window = Math.floor(Date.now() / 1000 / rule.windowSeconds);
  const key = `rl:${rule.name}:${identity}:${String(window)}`;

  try {
    const client = redis();
    const [count] = await client
      .multi()
      .incr(key)
      .expire(key, rule.windowSeconds)
      .exec()
      .then((replies) => (replies ?? []).map(([, value]) => Number(value)));

    const used = count ?? 0;
    const nextWindowAt = (window + 1) * rule.windowSeconds;

    return {
      allowed: used <= rule.limit,
      remaining: Math.max(0, rule.limit - used),
      retryAfterSeconds: Math.max(1, nextWindowAt - Math.floor(Date.now() / 1000)),
    };
  } catch (error) {
    console.error(`[rate-limit] ${rule.name} unavailable, allowing request`, error);
    return { allowed: true, remaining: rule.limit, retryAfterSeconds: 0 };
  }
}

/** Consume a unit and throw `RateLimitError` when the budget is gone. */
export async function enforceRateLimit(name: RateLimitName, identity: string): Promise<void> {
  const result = await consumeRateLimit(rateLimits[name], identity);
  if (!result.allowed) {
    throw new RateLimitError(result.retryAfterSeconds);
  }
}

/**
 * Identity for an anonymous caller.
 *
 * The raw address is never used as a key so that Redis does not become an
 * address log; the hash is stable for the process lifetime, which is all the
 * bucket needs.
 */
export async function hashIdentity(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest).slice(0, 12))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
