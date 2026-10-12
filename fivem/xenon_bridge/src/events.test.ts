import { describe, expect, it } from 'vitest';

import {
  banFromTxAdmin,
  isPlayerSource,
  isUnreachableStatus,
  newEventId,
  parseFailMode,
  parseIdentifiers,
  restartFromTxAdmin,
} from './events';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('parseIdentifiers', () => {
  it('normalises known kinds and drops unknown or malformed ones', () => {
    expect(
      parseIdentifiers([
        'license:abc123',
        'steam:110000100000001',
        'ip:127.0.0.1',
        'discord:',
        'fivem:12 34',
        42,
      ]),
    ).toEqual([
      { kind: 'LICENSE', value: 'abc123' },
      { kind: 'STEAM', value: '110000100000001' },
    ]);
  });

  it('caps the list at sixteen entries', () => {
    const many = Array.from({ length: 30 }, (_, index) => `license:id${String(index)}`);
    expect(parseIdentifiers(many)).toHaveLength(16);
  });
});

describe('newEventId', () => {
  it('produces distinct v4 UUIDs', () => {
    const first = newEventId();
    expect(first).toMatch(UUID_V4);
    expect(newEventId()).not.toBe(first);
  });
});

describe('isPlayerSource', () => {
  it.each([1, 12, '3', ' 7 '])('treats %o as a player', (value) => {
    expect(isPlayerSource(value)).toBe(true);
  });

  it.each(['', '0', 0, -1, undefined, null])('treats %o as the server', (value) => {
    expect(isPlayerSource(value)).toBe(false);
  });
});

describe('parseFailMode', () => {
  it('defaults to open when unset', () => {
    expect(parseFailMode('')).toEqual({ mode: 'open', recognised: true });
    expect(parseFailMode('open')).toEqual({ mode: 'open', recognised: true });
  });

  it('accepts closed in any case', () => {
    expect(parseFailMode(' CLOSED ')).toEqual({ mode: 'closed', recognised: true });
  });

  it('fails closed on a typo rather than guessing the permissive reading', () => {
    expect(parseFailMode('close')).toEqual({ mode: 'closed', recognised: false });
  });
});

describe('restartFromTxAdmin', () => {
  it('reads secondsRemaining and clamps it to a day', () => {
    expect(restartFromTxAdmin({ secondsRemaining: 300.4 })).toEqual({
      type: 'SERVER_RESTART_SCHEDULED',
      secondsRemaining: 300,
    });
    expect(restartFromTxAdmin({ secondsRemaining: 10 ** 9 })?.secondsRemaining).toBe(86_400);
  });

  it.each([null, 'soon', {}, { secondsRemaining: 'ten' }])('ignores %o', (payload) => {
    expect(restartFromTxAdmin(payload)).toBeNull();
  });
});

describe('banFromTxAdmin', () => {
  const now = 1_800_000_000;

  it('maps a temporary ban', () => {
    expect(
      banFromTxAdmin(
        {
          author: 'admin',
          reason: '  RDM  ',
          actionId: 'ABCD-1234',
          expiration: now + 3600,
          targetName: 'Player',
          targetIds: ['license:abc', 'discord:123456789012345678', 'ip:1.2.3.4'],
        },
        now,
      ),
    ).toEqual({
      type: 'PLAYER_BANNED',
      identifiers: [
        { kind: 'LICENSE', value: 'abc' },
        { kind: 'DISCORD', value: '123456789012345678' },
      ],
      playerName: 'Player',
      reason: 'RDM',
      durationSeconds: 3600,
      externalRef: 'ABCD-1234',
    });
  });

  it('treats expiration false as permanent', () => {
    const event = banFromTxAdmin({ targetIds: ['license:abc'], expiration: false }, now);
    expect(event?.durationSeconds).toBeNull();
    expect(event?.externalRef).toBeNull();
    expect(event?.reason).toBe('');
  });

  it('returns null when the payload names no usable identifier', () => {
    expect(banFromTxAdmin({ targetIds: ['ip:1.2.3.4'] }, now)).toBeNull();
    expect(banFromTxAdmin({ reason: 'x' }, now)).toBeNull();
    expect(banFromTxAdmin('nope', now)).toBeNull();
  });
});

describe('connect gate failure classification', () => {
  it('applies the fail mode only to outages', () => {
    expect(isUnreachableStatus(0)).toBe(true);
    expect(isUnreachableStatus(502)).toBe(true);
    expect(isUnreachableStatus(503)).toBe(true);
  });

  it('never treats a refusal from Xenon as an outage', () => {
    // Wrong secret, replay, malformed body, exhausted rate limit: Xenon is up
    // and said no, so the gate must not open in fail-open mode.
    for (const status of [400, 401, 403, 409, 422, 429]) {
      expect(isUnreachableStatus(status)).toBe(false);
    }
  });
});
