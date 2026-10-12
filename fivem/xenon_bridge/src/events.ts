import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Pure helpers for the bridge: identifier parsing, event ids, fail mode and
 * the shape of the events forwarded to `POST /api/bridge/events`.
 *
 * Nothing here touches an FXServer global, so it is unit tested under Node.
 * The payload shapes mirror `packages/contracts/src/fivem-bridge.ts`; this
 * resource runs outside the monorepo and cannot import it at runtime.
 */

export interface Identifier {
  readonly kind: string;
  readonly value: string;
}

const KNOWN_PREFIXES: Record<string, true> = {
  license: true,
  license2: true,
  steam: true,
  discord: true,
  fivem: true,
  xbl: true,
  live: true,
};
/** What Xenon's contract accepts for an identifier value. */
const IDENTIFIER_VALUE = /^[A-Za-z0-9:_.-]{1,128}$/;
const MAX_IDENTIFIERS = 16;
const MAX_RESTART_SECONDS = 24 * 60 * 60;

/** Parse FXServer's `kind:value` form, dropping kinds Xenon does not know. */
export function parseIdentifier(raw: unknown): Identifier | null {
  if (typeof raw !== 'string') return null;
  const separator = raw.indexOf(':');
  if (separator <= 0) return null;

  const prefix = raw.slice(0, separator).toLowerCase();
  const value = raw.slice(separator + 1);
  if (KNOWN_PREFIXES[prefix] !== true || !IDENTIFIER_VALUE.test(value)) return null;

  return { kind: prefix.toUpperCase(), value };
}

/** Parse and cap a list of raw identifiers. */
export function parseIdentifiers(raw: readonly unknown[]): Identifier[] {
  const output: Identifier[] = [];
  for (const entry of raw) {
    const parsed = parseIdentifier(entry);
    if (parsed !== null) output.push(parsed);
    if (output.length === MAX_IDENTIFIERS) break;
  }
  return output;
}

/**
 * A v4 UUID for the event id (Xenon's idempotency key).
 *
 * `randomUUID` exists on every FXServer Node runtime this resource targets
 * (Node 16+); the fallback builds the same thing from the CSPRNG in case an
 * older artifact lacks it.
 */
export function newEventId(): string {
  if (typeof randomUUID === 'function') return randomUUID();

  const bytes = randomBytes(16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * True when an event handler's `source` is a connected player.
 *
 * txAdmin raises its events server-side, where `source` is empty (or 0). A
 * player id there means a client managed to trigger the event over the
 * network - e.g. because some other resource registered it as a net event -
 * and it must be ignored: a client must never be able to fake a ban or a
 * restart announcement.
 */
export function isPlayerSource(value: unknown): boolean {
  if (typeof value === 'number') return value > 0;
  if (typeof value === 'string') return value.trim() !== '' && value.trim() !== '0';
  return false;
}

export type FailMode = 'open' | 'closed';

/**
 * Read the `xenon_fail_mode` convar.
 *
 * Unset means `open` (the historical behaviour). An unrecognised value is
 * treated as `closed`: an operator who typed `close` meant to shut the gate,
 * and guessing the permissive reading would silently do the opposite.
 */
export function parseFailMode(raw: string): { mode: FailMode; recognised: boolean } {
  const value = raw.trim().toLowerCase();
  if (value === '' || value === 'open') return { mode: 'open', recognised: true };
  if (value === 'closed') return { mode: 'closed', recognised: true };
  return { mode: 'closed', recognised: false };
}

export const UNAVAILABLE_MESSAGE = 'Xenon is temporarily unavailable. Try again in a minute.';

/**
 * Whether a failed connect check means "Xenon could not be reached" — the only
 * case the fail mode applies to. A transport failure (status 0) or a 5xx is an
 * outage. Any 4xx (bad signature, replay, malformed body, rate limit) is Xenon
 * answering and refusing, so it never opens the gate: otherwise a wrong secret,
 * or players exhausting a rate limit, would admit everybody.
 */
export function isUnreachableStatus(status: number): boolean {
  return status === 0 || status >= 500;
}

export const UNVERIFIED_MESSAGE =
  'Xenon could not verify your whitelist right now. Try again in a minute.';

export interface RestartEvent {
  readonly type: 'SERVER_RESTART_SCHEDULED';
  readonly secondsRemaining: number;
}

/** `txAdmin:events:scheduledRestart` → event body, or null when unreadable. */
export function restartFromTxAdmin(payload: unknown): RestartEvent | null {
  if (typeof payload !== 'object' || payload === null || !('secondsRemaining' in payload)) {
    return null;
  }
  const seconds = payload.secondsRemaining;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  return {
    type: 'SERVER_RESTART_SCHEDULED',
    secondsRemaining: Math.min(MAX_RESTART_SECONDS, Math.max(0, Math.round(seconds))),
  };
}

export interface BanEvent {
  readonly type: 'PLAYER_BANNED';
  readonly identifiers: Identifier[];
  readonly playerName: string;
  readonly reason: string;
  readonly durationSeconds: number | null;
  readonly externalRef: string | null;
}

/**
 * `txAdmin:events:playerBanned` → event body, or null when it names nobody.
 *
 * Read defensively: the payload has changed across txAdmin versions. Known
 * fields: `targetIds` (identifier strings), `targetName`, `reason`,
 * `actionId`, and `expiration` (unix seconds, or false/null when permanent);
 * some builds send `durationSeconds` instead.
 */
export function banFromTxAdmin(payload: unknown, nowSeconds: number): BanEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  // Own enumerable fields only, each checked with `typeof` before use.
  const body: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(payload));

  const rawIds: readonly unknown[] = Array.isArray(body.targetIds)
    ? body.targetIds
    : Array.isArray(body.identifiers)
      ? body.identifiers
      : [];
  const identifiers = parseIdentifiers(rawIds);
  if (identifiers.length === 0) return null;

  let durationSeconds: number | null = null;
  if (typeof body.expiration === 'number' && Number.isFinite(body.expiration)) {
    durationSeconds = Math.max(0, Math.round(body.expiration - nowSeconds));
  } else if (typeof body.durationSeconds === 'number' && Number.isFinite(body.durationSeconds)) {
    durationSeconds = Math.max(0, Math.round(body.durationSeconds));
  }

  const actionId = body.actionId;
  const externalRef =
    typeof actionId === 'string' || typeof actionId === 'number'
      ? String(actionId).trim().slice(0, 64) || null
      : null;

  return {
    type: 'PLAYER_BANNED',
    identifiers,
    playerName: typeof body.targetName === 'string' ? body.targetName.trim().slice(0, 64) : '',
    reason: typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '',
    durationSeconds,
    externalRef,
  };
}
