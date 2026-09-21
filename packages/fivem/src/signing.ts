import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Request signing between Xenon and the in-game bridge.
 *
 * The bridge runs on a machine Xenon does not control and calls endpoints that
 * link accounts and read whitelist state, so "is this really our server" has to
 * be answerable without a shared session. HMAC over the body plus a timestamp
 * and a nonce gives that: an attacker who cannot read the secret cannot forge a
 * request, and one who captures a valid request cannot replay it.
 *
 * Deliberately not JWT. There is no third party, no key rotation story needed
 * for a single shared secret, and a signature over the exact bytes is easier to
 * reason about than a token format with a decade of parser bugs.
 */

export const SIGNATURE_HEADER = 'x-xenon-signature';
export const TIMESTAMP_HEADER = 'x-xenon-timestamp';
export const NONCE_HEADER = 'x-xenon-nonce';

/** Clock skew tolerance. Wide enough for a badly synced game box, narrow
 * enough that a captured request is useless by the time it is found. */
const MAX_SKEW_SECONDS = 300;

export interface SignedHeaders {
  readonly [SIGNATURE_HEADER]: string;
  readonly [TIMESTAMP_HEADER]: string;
  readonly [NONCE_HEADER]: string;
}

function computeSignature(secret: string, timestamp: string, nonce: string, body: string): string {
  // The timestamp and nonce are inside the signed material, so neither can be
  // altered without invalidating the signature.
  return createHmac('sha256', secret).update(`${timestamp}.${nonce}.${body}`).digest('hex');
}

/** Sign an outbound request body. */
export function signRequest(secret: string, body: string): SignedHeaders {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString('hex');

  return {
    [SIGNATURE_HEADER]: computeSignature(secret, timestamp, nonce, body),
    [TIMESTAMP_HEADER]: timestamp,
    [NONCE_HEADER]: nonce,
  };
}

export type VerificationResult =
  { ok: true; nonce: string } | { ok: false; reason: 'missing' | 'stale' | 'invalid' | 'replayed' };

/**
 * Verify an inbound request.
 *
 * `seenNonce` is injected rather than kept here because replay detection needs
 * shared state across web instances, and that state is Redis. Returning the
 * nonce lets the caller record it only after the signature has passed, so an
 * unauthenticated flood cannot fill the replay cache.
 */
export function verifyRequest(
  secret: string,
  body: string,
  headers: {
    signature?: string | null;
    timestamp?: string | null;
    nonce?: string | null;
  },
  now: number = Date.now(),
): VerificationResult {
  const { signature, timestamp, nonce } = headers;
  if (!signature || !timestamp || !nonce) return { ok: false, reason: 'missing' };

  const sent = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(sent)) return { ok: false, reason: 'invalid' };

  const skew = Math.abs(Math.floor(now / 1000) - sent);
  if (skew > MAX_SKEW_SECONDS) return { ok: false, reason: 'stale' };

  const expected = computeSignature(secret, timestamp, nonce, body);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  // Length is checked first because timingSafeEqual throws on a mismatch, and
  // the comparison itself must not leak where the strings diverge.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'invalid' };
  }

  return { ok: true, nonce };
}
