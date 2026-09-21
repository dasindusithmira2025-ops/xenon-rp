import { describe, expect, it } from 'vitest';

import {
  NONCE_HEADER,
  SIGNATURE_HEADER,
  signRequest,
  TIMESTAMP_HEADER,
  verifyRequest,
} from './signing';

const SECRET = 'a-shared-bridge-secret-at-least-32-chars';

function headersFrom(signed: Record<string, string>) {
  return {
    signature: signed[SIGNATURE_HEADER],
    timestamp: signed[TIMESTAMP_HEADER],
    nonce: signed[NONCE_HEADER],
  };
}

describe('bridge request signing', () => {
  const body = JSON.stringify({ code: 'XEN-7K4P9', identifiers: ['license:abc'] });

  it('verifies a request it just signed', () => {
    const signed = signRequest(SECRET, body);
    const result = verifyRequest(SECRET, body, headersFrom(signed));
    expect(result.ok).toBe(true);
  });

  it('rejects a request signed with a different secret', () => {
    const signed = signRequest('some-other-secret-value-thirty-two-ch', body);
    expect(verifyRequest(SECRET, body, headersFrom(signed))).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('rejects a body that was altered after signing', () => {
    // The whole point: an attacker who can see a valid request must not be able
    // to change which account it links.
    const signed = signRequest(SECRET, body);
    const tampered = JSON.stringify({ code: 'XEN-7K4P9', identifiers: ['license:attacker'] });
    expect(verifyRequest(SECRET, tampered, headersFrom(signed)).ok).toBe(false);
  });

  it('rejects a timestamp outside the skew window', () => {
    const signed = signRequest(SECRET, body);
    const tenMinutesLater = Date.now() + 10 * 60 * 1000;
    expect(verifyRequest(SECRET, body, headersFrom(signed), tenMinutesLater)).toEqual({
      ok: false,
      reason: 'stale',
    });
  });

  it('rejects a timestamp far in the future', () => {
    const signed = signRequest(SECRET, body);
    const tenMinutesEarlier = Date.now() - 10 * 60 * 1000;
    expect(verifyRequest(SECRET, body, headersFrom(signed), tenMinutesEarlier).ok).toBe(false);
  });

  it('rejects a request with the timestamp swapped out', () => {
    // The timestamp is inside the signed material, so moving it forward to beat
    // the skew check invalidates the signature.
    const signed = signRequest(SECRET, body);
    const moved = {
      ...headersFrom(signed),
      timestamp: String(Math.floor(Date.now() / 1000) + 60),
    };
    expect(verifyRequest(SECRET, body, moved)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a request with the nonce swapped out', () => {
    const signed = signRequest(SECRET, body);
    const swapped = { ...headersFrom(signed), nonce: 'deadbeefdeadbeefdeadbeefdeadbeef' };
    expect(verifyRequest(SECRET, body, swapped)).toEqual({ ok: false, reason: 'invalid' });
  });

  it.each([
    ['signature', { signature: null }],
    ['timestamp', { timestamp: null }],
    ['nonce', { nonce: null }],
  ])('rejects a request missing the %s header', (_name, missing) => {
    const signed = signRequest(SECRET, body);
    expect(verifyRequest(SECRET, body, { ...headersFrom(signed), ...missing })).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it('rejects a non-numeric timestamp', () => {
    const signed = signRequest(SECRET, body);
    expect(verifyRequest(SECRET, body, { ...headersFrom(signed), timestamp: 'yesterday' })).toEqual(
      { ok: false, reason: 'invalid' },
    );
  });

  it('returns the nonce so the caller can record it for replay defence', () => {
    const signed = signRequest(SECRET, body);
    const result = verifyRequest(SECRET, body, headersFrom(signed));
    expect(result).toEqual({ ok: true, nonce: signed[NONCE_HEADER] });
  });

  it('produces a distinct nonce on every signing', () => {
    const nonces = new Set(
      Array.from({ length: 50 }, () => signRequest(SECRET, body)[NONCE_HEADER]),
    );
    expect(nonces.size).toBe(50);
  });
});
