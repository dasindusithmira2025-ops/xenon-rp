import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The Xenon side of the bridge.
 *
 * Signing is duplicated here rather than imported from `@xenon/fivem` on
 * purpose: this resource is copied into a FiveM server's resources directory
 * and runs outside the monorepo, so it cannot depend on a workspace package at
 * runtime. The scheme is small and stable, and `packages/fivem/src/signing.ts`
 * has the unit tests that prove both halves agree.
 *
 * If you change the scheme, change both.
 */

const SIGNATURE_HEADER = 'x-xenon-signature';
const TIMESTAMP_HEADER = 'x-xenon-timestamp';
const NONCE_HEADER = 'x-xenon-nonce';

const MAX_SKEW_SECONDS = 300;

function computeSignature(secret: string, timestamp: string, nonce: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${nonce}.${body}`).digest('hex');
}

export interface BridgeConfig {
  readonly endpoint: string;
  readonly secret: string;
  readonly slug: string;
}

/** Read configuration from server.cfg convars. */
export function readConfig(): BridgeConfig | null {
  const endpoint = GetConvar('xenon_endpoint', '').replace(/\/$/, '');
  const secret = GetConvar('xenon_secret', '');
  const slug = GetConvar('xenon_slug', 'xenon-main');

  if (endpoint.length === 0 || secret.length < 32) return null;
  return { endpoint, secret, slug };
}

export interface XenonResponse<T> {
  readonly ok: boolean;
  readonly status: number;
  readonly body: T | null;
}

/**
 * Call Xenon.
 *
 * Bounded by a timeout, because this runs inside a connecting player's
 * deferral and a hung request would leave them staring at a loading screen
 * until the server gave up on them.
 */
export async function callXenon<T>(
  config: BridgeConfig,
  path: string,
  payload: unknown,
  timeoutMs = 5_000,
): Promise<XenonResponse<T>> {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString('hex');

  try {
    const response = await fetch(`${config.endpoint}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: computeSignature(config.secret, timestamp, nonce, body),
        [TIMESTAMP_HEADER]: timestamp,
        [NONCE_HEADER]: nonce,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });

    const parsed = (await response.json().catch(() => null)) as T | null;
    return { ok: response.ok, status: response.status, body: parsed };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

/** Verify a request Xenon sent us. Same scheme, opposite direction. */
export function verifyFromXenon(
  config: BridgeConfig,
  body: string,
  headers: Record<string, string | undefined>,
): boolean {
  const signature = headers[SIGNATURE_HEADER] ?? headers[SIGNATURE_HEADER.toLowerCase()];
  const timestamp = headers[TIMESTAMP_HEADER] ?? headers[TIMESTAMP_HEADER.toLowerCase()];
  const nonce = headers[NONCE_HEADER] ?? headers[NONCE_HEADER.toLowerCase()];

  if (
    signature === undefined ||
    timestamp === undefined ||
    nonce === undefined ||
    signature.length === 0
  ) {
    return false;
  }

  const sent = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(sent)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - sent) > MAX_SKEW_SECONDS) return false;

  const expected = computeSignature(config.secret, timestamp, nonce, body);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');

  // Length first: timingSafeEqual throws on a mismatch, and the comparison
  // itself must not leak where the strings diverge.
  return a.length === b.length && timingSafeEqual(a, b);
}
