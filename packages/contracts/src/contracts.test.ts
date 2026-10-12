import { describe, expect, it } from 'vitest';

import {
  CORE_OPERATIONS,
  GATEWAY_BODY_LIMIT_BYTES,
  GUARDIAN_COMMAND_NAMES,
  LINK_COMMAND_NAMES,
  LINK_RELAY_MAX_BATCH,
  LINK_RELAY_MAX_WAIT_MS,
  NonceCache,
  RELAY_OPERATIONS,
  assertCommandOwnership,
  coreOperations,
  isRelayOperation,
  isTrustedIdentityKind,
  linkRelayOperations,
  parseIntegrationEvent,
  relayRequestSchema,
  signServiceRequest,
  verifyServiceRequest,
} from './index';

const SECRET = 'a'.repeat(48);
const parts = {
  service: 'link',
  method: 'POST',
  path: '/internal/v1/link.status',
  body: '{"actorDiscordId":"123456789012345678"}',
} as const;

function headerReader(headers: Record<string, string>) {
  return (name: string) => headers[name] ?? null;
}

describe('service authentication', () => {
  it('accepts a request signed for the same service, method, path and body', () => {
    const headers = signServiceRequest(SECRET, parts);
    const result = verifyServiceRequest(SECRET, parts, parts.body, headerReader({ ...headers }));
    expect(result.ok).toBe(true);
  });

  it('rejects a signed request replayed against a different endpoint', () => {
    const headers = signServiceRequest(SECRET, parts);
    const result = verifyServiceRequest(
      SECRET,
      { ...parts, path: '/internal/v1/roles.sync' },
      parts.body,
      headerReader({ ...headers }),
    );
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a tampered body, a wrong secret, and a different calling service', () => {
    const headers = headerReader({ ...signServiceRequest(SECRET, parts) });
    expect(verifyServiceRequest(SECRET, parts, '{"actorDiscordId":"1"}', headers).ok).toBe(false);
    expect(verifyServiceRequest('b'.repeat(48), parts, parts.body, headers).ok).toBe(false);
    expect(
      verifyServiceRequest(SECRET, { ...parts, service: 'worker' }, parts.body, headers),
    ).toEqual({ ok: false, reason: 'wrong-service' });
  });

  it('rejects a request outside the clock-skew window', () => {
    const signedAt = Date.now() - 10 * 60_000;
    const headers = signServiceRequest(SECRET, parts, signedAt);
    expect(verifyServiceRequest(SECRET, parts, parts.body, headerReader({ ...headers }))).toEqual({
      ok: false,
      reason: 'stale',
    });
  });

  it('remembers nonces so a captured request cannot be replayed inside the window', () => {
    const cache = new NonceCache(60_000, 10);
    expect(cache.remember('n1', 0)).toBe(true);
    expect(cache.remember('n1', 1_000)).toBe(false);
    expect(cache.remember('n1', 61_000)).toBe(true);
  });

  it('bounds the nonce cache without forgetting fresh entries first', () => {
    const cache = new NonceCache(60_000, 2);
    cache.remember('a', 0);
    cache.remember('b', 1);
    cache.remember('c', 2);
    // `a` was evicted as the oldest; `c` is still remembered.
    expect(cache.remember('c', 3)).toBe(false);
    expect(cache.remember('a', 4)).toBe(true);
  });
});

describe('integration events', () => {
  const base = {
    id: 'evt_1',
    idempotencyKey: 'application.approved:XN-WL-1',
    occurredAt: new Date().toISOString(),
    source: 'DISCORD',
    type: 'WHITELIST_APPROVED',
    version: 1,
    payload: {
      playerPublicId: 'XN-10082',
      discordId: '123456789012345678',
      applicationPublicId: 'XN-WL-1',
    },
  };

  it('parses a valid versioned envelope', () => {
    expect(parseIntegrationEvent(base).ok).toBe(true);
  });

  it('rejects an unknown version rather than misreading it', () => {
    expect(parseIntegrationEvent({ ...base, version: 2 }).ok).toBe(false);
  });

  it('rejects an unknown event type', () => {
    expect(parseIntegrationEvent({ ...base, type: 'PLAYER_TELEPORTED' }).ok).toBe(false);
  });

  it('strips fields outside the contract so game identifiers cannot leak through an event', () => {
    const parsed = parseIntegrationEvent({
      ...base,
      payload: { ...base.payload, license: 'license:abc123' },
    });
    expect(parsed.ok && 'license' in parsed.event.payload).toBe(false);
  });

  it('trusts only server-verified identifier kinds for admission', () => {
    expect(isTrustedIdentityKind('LICENSE')).toBe(true);
    expect(isTrustedIdentityKind('FIVEM')).toBe(true);
    expect(isTrustedIdentityKind('DISCORD')).toBe(false);
    expect(isTrustedIdentityKind('STEAM')).toBe(false);
  });
});

describe('command ownership', () => {
  it('assigns every top-level command to exactly one application', () => {
    const guardian = new Set<string>(GUARDIAN_COMMAND_NAMES);
    expect(LINK_COMMAND_NAMES.filter((name) => guardian.has(name))).toEqual([]);
  });

  it('refuses a registry that contains another application’s command', () => {
    const registry = [...LINK_COMMAND_NAMES, 'ban'].map((name) => ({ name }));
    expect(() => {
      assertCommandOwnership('link', registry);
    }).toThrow(/foreign/);
  });

  it('refuses a registry with a missing or duplicated command', () => {
    expect(() => {
      assertCommandOwnership(
        'guardian',
        GUARDIAN_COMMAND_NAMES.slice(1).map((name) => ({ name })),
      );
    }).toThrow(/missing/);
    expect(() => {
      assertCommandOwnership(
        'link',
        [...LINK_COMMAND_NAMES, 'link'].map((name) => ({ name })),
      );
    }).toThrow(/duplicates/);
  });
});

describe('link relay contract', () => {
  const validRequest = {
    id: 'a'.repeat(32),
    lease: 'b'.repeat(32),
    operation: 'guild.info',
    body: '{}',
    timestamp: '1700000000',
    signature: 'c'.repeat(64),
    budgetMs: 12_000,
  };

  it('is served through Core operations', () => {
    expect(RELAY_OPERATIONS).toEqual(['relay.pull', 'relay.complete']);
    for (const name of RELAY_OPERATIONS) {
      expect(CORE_OPERATIONS).toContain(name);
      expect(coreOperations[name]).toBe(linkRelayOperations[name]);
    }
    expect(isRelayOperation('relay.pull')).toBe(true);
    expect(isRelayOperation('status.board')).toBe(false);
    expect(isRelayOperation('toString')).toBe(false);
  });

  it('bounds relay.pull input', () => {
    const { input } = linkRelayOperations['relay.pull'];
    const ok = {
      maxRequests: LINK_RELAY_MAX_BATCH,
      waitMs: LINK_RELAY_MAX_WAIT_MS,
      discordReady: true,
    };
    expect(input.safeParse(ok).success).toBe(true);
    expect(input.safeParse({ ...ok, maxRequests: 0, waitMs: 0 }).success).toBe(true);
    expect(input.safeParse({ ...ok, maxRequests: LINK_RELAY_MAX_BATCH + 1 }).success).toBe(false);
    expect(input.safeParse({ ...ok, waitMs: LINK_RELAY_MAX_WAIT_MS + 1 }).success).toBe(false);
    expect(input.safeParse({ ...ok, maxRequests: -1 }).success).toBe(false);
    expect(input.safeParse({ ...ok, waitMs: -1 }).success).toBe(false);
    expect(input.safeParse({ ...ok, maxRequests: 1.5 }).success).toBe(false);
    expect(input.safeParse({ maxRequests: 1, waitMs: 0 }).success).toBe(false);
  });

  it('validates a claimed request strictly', () => {
    expect(relayRequestSchema.safeParse(validRequest).success).toBe(true);
    expect(relayRequestSchema.safeParse({ ...validRequest, id: 'Z'.repeat(32) }).success).toBe(
      false,
    );
    expect(relayRequestSchema.safeParse({ ...validRequest, id: 'a'.repeat(31) }).success).toBe(
      false,
    );
    expect(relayRequestSchema.safeParse({ ...validRequest, operation: 'guild.nuke' }).success).toBe(
      false,
    );
    expect(
      relayRequestSchema.safeParse({ ...validRequest, signature: 'c'.repeat(63) }).success,
    ).toBe(false);
    expect(relayRequestSchema.safeParse({ ...validRequest, timestamp: 'now' }).success).toBe(false);
    expect(relayRequestSchema.safeParse({ ...validRequest, budgetMs: -1 }).success).toBe(false);
    expect(
      relayRequestSchema.safeParse({
        ...validRequest,
        body: 'x'.repeat(GATEWAY_BODY_LIMIT_BYTES + 1),
      }).success,
    ).toBe(false);
  });

  it('bounds a pull reply to the batch size and requires Core poll age', () => {
    const { output } = linkRelayOperations['relay.pull'];
    const many = Array.from({ length: LINK_RELAY_MAX_BATCH + 1 }, () => validRequest);
    expect(
      output.safeParse({ requests: many.slice(0, LINK_RELAY_MAX_BATCH), claimElapsedMs: 20_000 })
        .success,
    ).toBe(true);
    expect(output.safeParse({ requests: many, claimElapsedMs: 20_000 }).success).toBe(false);
    expect(output.safeParse({ requests: [], claimElapsedMs: -1 }).success).toBe(false);
  });

  it('accepts both the ok and the error gateway envelope in relay.complete', () => {
    const { input } = linkRelayOperations['relay.complete'];
    const base = { id: 'a'.repeat(32), lease: 'b'.repeat(32), operation: 'guild.info' };
    expect(
      input.safeParse({ ...base, response: { ok: true, data: { anything: 1 } } }).success,
    ).toBe(true);
    expect(
      input.safeParse({
        ...base,
        response: {
          ok: false,
          error: {
            code: 'DISCORD_ERROR',
            message: 'Missing Permissions',
            retryable: false,
            discordCode: 50013,
          },
        },
      }).success,
    ).toBe(true);
    expect(
      input.safeParse({
        ...base,
        response: { ok: false, error: { code: 'NOPE', message: 'x', retryable: false } },
      }).success,
    ).toBe(false);
    expect(input.safeParse({ ...base, response: { status: 'fine' } }).success).toBe(false);
  });
});
