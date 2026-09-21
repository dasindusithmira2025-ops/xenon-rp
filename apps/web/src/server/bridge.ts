import 'server-only';

import { NextResponse } from 'next/server';

import { serverEnv } from '@xenon/config/server';
import { NONCE_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyRequest } from '@xenon/fivem';
import { enforceRateLimit, redis } from '@xenon/jobs';

/**
 * The FiveM bridge boundary.
 *
 * Requests arrive from a machine Xenon does not control and ask it to link
 * accounts and disclose whitelist state, so "is this really our game server"
 * has to be answerable without a session. Four things have to hold:
 *
 *  1. The shared secret is configured. Without it the endpoint does not exist,
 *     rather than existing with authentication disabled.
 *  2. The signature covers the exact bytes, plus the timestamp and the nonce,
 *     so nothing in the request can be altered without invalidating it.
 *  3. The timestamp is inside a five-minute window.
 *  4. The nonce has not been seen. That is what turns "cannot forge" into
 *     "cannot replay", and it is recorded in Redis so it holds across every web
 *     instance rather than per-process.
 */

/** Nonces are remembered for twice the skew window. Beyond that the timestamp check covers us. */
const NONCE_TTL_SECONDS = 600;

export type BridgeResult<T> = { ok: true; body: T } | { ok: false; response: NextResponse };

function refuse(status: number, message: string): NextResponse {
  // Deliberately terse. A misconfigured bridge should learn that it is
  // unauthorised, not which of the four checks it failed.
  return NextResponse.json({ ok: false, error: message }, { status });
}

/**
 * Verify an inbound bridge request and return its parsed body.
 *
 * The raw text is read first because the signature is over the bytes; parsing
 * and re-serialising would change them.
 */
export async function verifyBridgeRequest<T>(request: Request): Promise<BridgeResult<T>> {
  const secret = serverEnv.FIVEM_BRIDGE_SECRET;
  if (!secret) {
    return {
      ok: false,
      response: refuse(503, 'The FiveM bridge is not configured on this deployment'),
    };
  }

  const raw = await request.text();

  const verification = verifyRequest(secret, raw, {
    signature: request.headers.get(SIGNATURE_HEADER),
    timestamp: request.headers.get(TIMESTAMP_HEADER),
    nonce: request.headers.get(NONCE_HEADER),
  });

  if (!verification.ok) {
    return { ok: false, response: refuse(401, 'Unauthorised') };
  }

  // Only now is the nonce recorded: an unauthenticated flood must not be able
  // to fill the replay cache.
  try {
    const key = `bridge:nonce:${verification.nonce}`;
    const stored = await redis().set(key, '1', 'EX', NONCE_TTL_SECONDS, 'NX');
    if (stored === null) {
      return { ok: false, response: refuse(409, 'Replayed request') };
    }
  } catch {
    // Redis is down. The signature and the timestamp still hold, so the request
    // is authentic and at most five minutes old; refusing every connecting
    // player because the replay cache is unavailable would be worse than
    // accepting a theoretical replay inside that window.
    console.warn('[bridge] replay cache unavailable, accepting on signature alone');
  }

  // Rate limited per server rather than per player: this is one caller making
  // a request per connection, and the limit exists to bound a runaway loop.
  await enforceRateLimit('bridgeRequest', 'fivem');

  try {
    return { ok: true, body: JSON.parse(raw) as T };
  } catch {
    return { ok: false, response: refuse(400, 'Malformed body') };
  }
}
