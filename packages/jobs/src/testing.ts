import { LINK_RELAY_PRESENCE_TTL_SECONDS, relayRequestSchema } from '@xenon/contracts';
import type { RelayRequest } from '@xenon/contracts';

import {
  LINK_RELAY_CLAIM_SCAN_LIMIT,
  LINK_RELAY_GRACE_MS,
  LINK_RELAY_MAX_PENDING,
  type LinkRelayRead,
  type LinkRelayStore,
} from './link-relay';


/**
 * In-memory twin of the Redis link-relay store, for tests. Same semantics,
 * including TTL expiry of request hashes and of the presence key, driven by an
 * injectable clock. Not exported from the package index, so production bundles
 * never include it (`@xenon/jobs/testing`).
 */

interface Entry {
  readonly operation: string;
  readonly body: string;
  readonly timestamp: string;
  readonly signature: string;
  readonly exp: number;
  readonly dieAt: number;
  state: 'pending' | 'claimed' | 'done' | 'expired';
  lease?: string;
  response?: string;
}

export function createMemoryLinkRelayStore(
  options: { readonly now?: () => number } = {},
): LinkRelayStore {
  const now = options.now ?? Date.now;
  const requests = new Map<string, Entry>();
  /** Index 0 is the head: LPUSH = unshift, RPOP = pop. */
  const pending: string[] = [];
  let presence: { value: 'ready' | 'unready'; until: number } | undefined;

  function entry(id: string): Entry | undefined {
    const found = requests.get(id);
    if (found && now() >= found.dieAt) {
      requests.delete(id);
      return undefined;
    }
    return found;
  }

  function currentPresence(): 'ready' | 'unready' | undefined {
    if (presence && now() >= presence.until) presence = undefined;
    return presence?.value;
  }

  function view(found: Entry | undefined): LinkRelayRead {
    if (!found) return { state: 'missing' };
    if (found.state === 'done') return { state: 'done', response: found.response ?? '' };
    return { state: found.state };
  }

  return {
    enqueue: (envelope, ttlMs) => {
      const present = currentPresence();
      if (present === undefined) return Promise.resolve('offline');
      if (present !== 'ready') return Promise.resolve('not_ready');
      if (entry(envelope.id)) return Promise.resolve('duplicate');
      if (pending.length >= LINK_RELAY_MAX_PENDING) return Promise.resolve('full');
      const at = now();
      requests.set(envelope.id, {
        operation: envelope.operation,
        body: envelope.body,
        timestamp: envelope.timestamp,
        signature: envelope.signature,
        exp: at + ttlMs,
        dieAt: at + ttlMs + LINK_RELAY_GRACE_MS,
        state: 'pending',
      });
      pending.unshift(envelope.id);
      return Promise.resolve('queued');
    },

    read: (id) => Promise.resolve(view(entry(id))),

    abandon: (id) => {
      const before = view(entry(id));
      const at = pending.indexOf(id);
      if (at !== -1) pending.splice(at, 1);
      requests.delete(id);
      return Promise.resolve(before);
    },

    presence: () => {
      const value = currentPresence();
      return Promise.resolve({ state: value ?? 'absent', pending: pending.length });
    },

    markPresence: (discordReady) => {
      presence = {
        value: discordReady ? 'ready' : 'unready',
        until: now() + LINK_RELAY_PRESENCE_TTL_SECONDS * 1000,
      };
      return Promise.resolve();
    },

    claim: ({ max, lease, minBudgetMs }) => {
      const claimed: RelayRequest[] = [];
      let scanned = 0;
      const at = now();
      while (claimed.length < max && scanned < LINK_RELAY_CLAIM_SCAN_LIMIT) {
        const id = pending.pop();
        if (id === undefined) break;
        scanned += 1;
        const found = entry(id);
        if (found?.state !== 'pending') continue;
        const left = found.exp - at;
        if (left < minBudgetMs) {
          found.state = 'expired';
          continue;
        }
        found.state = 'claimed';
        found.lease = lease;
        const parsed = relayRequestSchema.safeParse({
          id,
          lease,
          operation: found.operation,
          body: found.body,
          timestamp: found.timestamp,
          signature: found.signature,
          budgetMs: left,
        });
        if (parsed.success) claimed.push(parsed.data);
      }
      return Promise.resolve(claimed);
    },

    complete: ({ id, lease, operation, response }) => {
      const found = entry(id);
      if (found?.lease !== lease || found.operation !== operation) return Promise.resolve(false);
      if (found.state === 'claimed') {
        found.state = 'done';
        found.response = response;
        return Promise.resolve(true);
      }
      return Promise.resolve(found.state === 'done');
    },
  };
}
