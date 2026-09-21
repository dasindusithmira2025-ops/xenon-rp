import { describe, expect, it } from 'vitest';

import { formatIdentifier, MockGameServerAdapter, parseIdentifier } from './adapter';
import { nextRestartAt } from './sync';

describe('parseIdentifier', () => {
  it('splits the FXServer kind:value form', () => {
    expect(parseIdentifier('steam:110000112345678')).toEqual({
      kind: 'STEAM',
      value: '110000112345678',
    });
  });

  it('keeps colons that appear inside the value', () => {
    expect(parseIdentifier('fivem:a:b')).toEqual({ kind: 'FIVEM', value: 'a:b' });
  });

  it('rejects an unknown prefix rather than guessing', () => {
    expect(parseIdentifier('tencent:12345')).toBeNull();
  });

  it.each(['', ':value', 'license', 'license:'])('rejects the malformed input %o', (input) => {
    expect(parseIdentifier(input)).toBeNull();
  });

  it('round-trips through formatIdentifier', () => {
    const parsed = parseIdentifier('license2:deadbeef');
    expect(parsed).not.toBeNull();
    expect(formatIdentifier(parsed!)).toBe('license2:deadbeef');
  });
});

describe('nextRestartAt', () => {
  const noon = new Date('2026-03-10T12:00:00.000Z');

  it('returns null when no schedule is configured', () => {
    expect(nextRestartAt(null, noon)).toBeNull();
    expect(nextRestartAt('   ', noon)).toBeNull();
  });

  it('finds the next hour in a comma list on the same day', () => {
    expect(nextRestartAt('0 6,12,18 * * *', noon)?.toISOString()).toBe('2026-03-10T18:00:00.000Z');
  });

  it('rolls over to tomorrow when every slot today has passed', () => {
    const lateEvening = new Date('2026-03-10T23:30:00.000Z');
    expect(nextRestartAt('0 6,12,18 * * *', lateEvening)?.toISOString()).toBe(
      '2026-03-11T06:00:00.000Z',
    );
  });

  it('handles a step expression', () => {
    expect(nextRestartAt('30 */6 * * *', noon)?.toISOString()).toBe('2026-03-10T12:30:00.000Z');
  });

  it('returns null for an expression it cannot read', () => {
    expect(nextRestartAt('nonsense', noon)).toBeNull();
    expect(nextRestartAt('0 25 * * *', noon)).toBeNull();
  });
});

describe('MockGameServerAdapter', () => {
  it('reports an empty server rather than inventing a player count', async () => {
    const reading = await new MockGameServerAdapter().status();
    expect(reading.online).toBe(true);
    expect(reading.playerCount).toBe(0);
  });

  it('records the pushes it receives so a test can assert on them', async () => {
    const adapter = new MockGameServerAdapter();
    await adapter.pushWhitelist({
      identifiers: [{ kind: 'LICENSE', value: 'abc' }],
      allowed: true,
      reason: null,
      publicId: 'XN-10082',
    });
    expect(adapter.pushes).toHaveLength(1);
    expect(adapter.pushes[0]?.allowed).toBe(true);
  });

  it('can be told to fail, so the retry path is testable', async () => {
    const adapter = new MockGameServerAdapter({ failNext: true });
    await expect(
      adapter.pushWhitelist({
        identifiers: [{ kind: 'LICENSE', value: 'abc' }],
        allowed: true,
        reason: null,
        publicId: 'XN-10082',
      }),
    ).rejects.toThrow(/Mock adapter/);
    expect(adapter.pushes).toHaveLength(0);
  });
});
