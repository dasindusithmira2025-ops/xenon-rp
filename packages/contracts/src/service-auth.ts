import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Service-to-service request authentication.
 *
 * Every internal call between Xenon services (Link → Core API, worker → Link
 * gateway) is an HMAC-SHA256 signature over:
 *
 *   service \n METHOD \n path \n timestamp \n nonce \n sha256(body)
 *
 * Binding the calling service name, the method and the path means a captured
 * request cannot be replayed against a different endpoint or presented as if a
 * different service sent it, and each direction uses its own secret so a leak
 * of one does not authenticate the other.
 *
 * Replay protection is the verifier's job: it records the nonce only after the
 * signature passes (see {@link NonceCache}).
 */

export const SERVICE_HEADER = 'x-xenon-service';
export const SERVICE_SIGNATURE_HEADER = 'x-xenon-service-signature';
export const SERVICE_TIMESTAMP_HEADER = 'x-xenon-service-timestamp';
export const SERVICE_NONCE_HEADER = 'x-xenon-service-nonce';

/** Both ends are our own NTP-synced hosts; two minutes covers deploy-time clock jitter. */
export const SERVICE_MAX_SKEW_SECONDS = 120;

export type ServiceName = 'link' | 'worker';

export interface ServiceRequestParts {
  readonly service: ServiceName;
  readonly method: string;
  /** Path only, including the query string if any. Never the host. */
  readonly path: string;
  readonly body: string;
}

export interface ServiceSignedHeaders {
  readonly [SERVICE_HEADER]: string;
  readonly [SERVICE_SIGNATURE_HEADER]: string;
  readonly [SERVICE_TIMESTAMP_HEADER]: string;
  readonly [SERVICE_NONCE_HEADER]: string;
}

function signatureFor(
  secret: string,
  parts: ServiceRequestParts,
  timestamp: string,
  nonce: string,
): string {
  const bodyHash = createHash('sha256').update(parts.body).digest('hex');
  return createHmac('sha256', secret)
    .update(
      [parts.service, parts.method.toUpperCase(), parts.path, timestamp, nonce, bodyHash].join(
        '\n',
      ),
    )
    .digest('hex');
}

export function signServiceRequest(
  secret: string,
  parts: ServiceRequestParts,
  now: number = Date.now(),
): ServiceSignedHeaders {
  const timestamp = Math.floor(now / 1000).toString();
  const nonce = randomBytes(16).toString('hex');
  return {
    [SERVICE_HEADER]: parts.service,
    [SERVICE_SIGNATURE_HEADER]: signatureFor(secret, parts, timestamp, nonce),
    [SERVICE_TIMESTAMP_HEADER]: timestamp,
    [SERVICE_NONCE_HEADER]: nonce,
  };
}

export type ServiceVerification =
  | { readonly ok: true; readonly nonce: string }
  | { readonly ok: false; readonly reason: 'missing' | 'wrong-service' | 'stale' | 'invalid' };

/** Header lookup that works for both `Headers` and Node's lower-cased header record. */
export type HeaderReader = (name: string) => string | null | undefined;

export function verifyServiceRequest(
  secret: string,
  expected: { readonly service: ServiceName; readonly method: string; readonly path: string },
  body: string,
  header: HeaderReader,
  now: number = Date.now(),
): ServiceVerification {
  const service = header(SERVICE_HEADER);
  const signature = header(SERVICE_SIGNATURE_HEADER);
  const timestamp = header(SERVICE_TIMESTAMP_HEADER);
  const nonce = header(SERVICE_NONCE_HEADER);
  if (!service || !signature || !timestamp || !nonce) return { ok: false, reason: 'missing' };
  if (service !== expected.service) return { ok: false, reason: 'wrong-service' };
  if (!/^[0-9a-f]{32}$/.test(nonce) || !/^\d{1,12}$/.test(timestamp)) {
    return { ok: false, reason: 'invalid' };
  }

  const skew = Math.abs(Math.floor(now / 1000) - Number.parseInt(timestamp, 10));
  if (skew > SERVICE_MAX_SKEW_SECONDS) return { ok: false, reason: 'stale' };

  const computed = Buffer.from(
    signatureFor(secret, { ...expected, body }, timestamp, nonce),
    'utf8',
  );
  const presented = Buffer.from(signature, 'utf8');
  if (computed.length !== presented.length || !timingSafeEqual(computed, presented)) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, nonce };
}

/**
 * In-process replay guard for a single-instance verifier (the Link gateway).
 *
 * Entries live for twice the skew window; beyond that the timestamp check
 * already rejects the request. Bounded so a flood of valid-but-unique requests
 * cannot grow memory without limit — the oldest entries are evicted first,
 * and they are the ones closest to expiring anyway.
 */
export class NonceCache {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs: number = SERVICE_MAX_SKEW_SECONDS * 2 * 1000,
    private readonly maxEntries = 50_000,
  ) {}

  /** Returns false when the nonce was already used inside the window. */
  remember(nonce: string, now: number = Date.now()): boolean {
    const previous = this.seen.get(nonce);
    if (previous !== undefined && now - previous < this.ttlMs) return false;

    this.seen.delete(nonce);
    this.seen.set(nonce, now);
    if (this.seen.size > this.maxEntries) {
      for (const [key, at] of this.seen) {
        if (this.seen.size <= this.maxEntries && now - at < this.ttlMs) break;
        this.seen.delete(key);
      }
    }
    return true;
  }
}

/** Minimum secret strength for service authentication. */
export const MIN_SERVICE_SECRET_LENGTH = 32;
