import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { datastoreEnv } from '@xenon/config/datastore';

/**
 * Hashing helpers for values that must be comparable but never readable.
 *
 * Addresses are recorded for abuse investigation, not for profiling, so only a
 * hash is stored. The pepper keeps the hash from being reversible by simply
 * hashing every address in a /24 - a salt-free SHA-256 of an IPv4 address is a
 * four-billion-entry rainbow table.
 */

/**
 * Development fallback.
 *
 * Only ever reachable outside production: `@xenon/config` refuses to start a
 * production process without HASH_PEPPER, precisely so that this constant can
 * never become the live pepper.
 */
const DEVELOPMENT_PEPPER = 'xenon-development-pepper-not-for-production';

function currentPepper(): string {
  return datastoreEnv.HASH_PEPPER ?? DEVELOPMENT_PEPPER;
}

/** Stable, non-reversible representation of a client address. */
export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return createHash('sha256').update(`${currentPepper()}:${ip}`).digest('hex').slice(0, 32);
}

/** SHA-256 of an arbitrary secret, hex encoded. Used for link tokens. */
export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time comparison, so a lookup cannot be turned into an oracle. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Cryptographically strong random token, hex encoded. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}
