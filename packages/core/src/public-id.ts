/**
 * Public identifiers.
 *
 * Every entity a human ever refers to has an identifier separate from its
 * database primary key: `XN-10082`, `XN-WL-1842`, `XN-TK-0452`. Two reasons.
 * Staff quote these in Discord and in voice, so they must be short and
 * speakable; and a URL must never expose a primary key, because enumerating
 * rows or counting them should not be possible from the outside.
 *
 * Numbers come from dedicated Postgres sequences rather than from `count() + 1`,
 * which races under concurrency, and rather than from the row id, which would
 * defeat the point.
 */

export const PUBLIC_ID_PREFIX = 'XN';

/** Entity families that own a counter. */
export const publicIdKinds = {
  user: { sequence: 'public_id_user_seq', segment: null, pad: 5 },
  /** Segment is supplied per application template, e.g. `WL`, `PD`, `EMS`. */
  application: { sequence: 'public_id_application_seq', segment: null, pad: 4 },
  character: { sequence: 'public_id_character_seq', segment: 'CH', pad: 4 },
  ticket: { sequence: 'public_id_ticket_seq', segment: 'TK', pad: 4 },
  interview: { sequence: 'public_id_interview_seq', segment: 'IV', pad: 4 },
  report: { sequence: 'public_id_report_seq', segment: 'RP', pad: 4 },
  appeal: { sequence: 'public_id_appeal_seq', segment: 'AP', pad: 4 },
} as const satisfies Record<string, { sequence: string; segment: string | null; pad: number }>;

export type PublicIdKind = keyof typeof publicIdKinds;

/**
 * Segments are uppercase A-Z, two to four characters.
 *
 * Bounded because staff type them when creating a template and read them aloud
 * in voice channels; letters only, so a segment can never be mistaken for the
 * numeric part.
 */
export const SEGMENT_PATTERN = /^[A-Z]{2,4}$/;

const PUBLIC_ID_PATTERN = /^XN-(?:([A-Z]{2,4})-)?(\d{3,10})$/;
const BARE_NUMBER_PATTERN = /^\d{1,10}$/;

export interface ParsedPublicId {
  /** Segment between the prefix and the number, or null when there is none. */
  readonly segment: string | null;
  readonly sequence: number;
}

/**
 * Which segment a bare number should be read as.
 *
 * `null` means "a user", a string means that entity family, and omitting the
 * argument means the caller has no context and a bare number must be rejected.
 */
export type DefaultSegment = string | null;

/** Build a public identifier. Pure: takes an already-allocated number. */
export function formatPublicId(sequence: number, segment: string | null, pad: number): string {
  if (!Number.isInteger(sequence) || sequence <= 0) {
    throw new RangeError(`Public id sequence must be a positive integer, received ${sequence}`);
  }
  if (segment !== null && !SEGMENT_PATTERN.test(segment)) {
    throw new RangeError(`Invalid public id segment: ${segment}`);
  }

  const digits = String(sequence).padStart(pad, '0');
  return segment === null
    ? `${PUBLIC_ID_PREFIX}-${digits}`
    : `${PUBLIC_ID_PREFIX}-${segment}-${digits}`;
}

/** Parse a public identifier, returning null when the shape is wrong. */
export function parsePublicId(value: string): ParsedPublicId | null {
  const match = PUBLIC_ID_PATTERN.exec(value.trim().toUpperCase());
  if (match === null) return null;

  const [, segment, digits] = match;
  if (digits === undefined) return null;

  return { segment: segment ?? null, sequence: Number.parseInt(digits, 10) };
}

/** True when `value` is a syntactically valid public identifier. */
export function isPublicId(value: string): boolean {
  return PUBLIC_ID_PATTERN.test(value.trim().toUpperCase());
}

/** Padding that a given segment implies. Users are wider than everything else. */
function padForSegment(segment: string | null): number {
  return segment === null ? publicIdKinds.user.pad : publicIdKinds.ticket.pad;
}

/**
 * Accept the forms a human actually types.
 *
 * Staff paste `xn-wl-1842`, type `XN WL 1842`, or drop the prefix and write
 * `WL-1842`. Normalising here means search boxes and Discord commands do not
 * each grow their own lenient parser.
 *
 * A bare number is handled first and separately. Without that, `1842` would
 * fall through to the "add the missing prefix" branch, match the no-segment
 * form and silently resolve to user XN-01842 - routing staff to an unrelated
 * record that really does exist.
 */
export function normalisePublicId(input: string, defaultSegment?: DefaultSegment): string | null {
  const cleaned = input
    .trim()
    .toUpperCase()
    .replace(/[\s_]+/g, '-');

  if (BARE_NUMBER_PATTERN.test(cleaned)) {
    if (defaultSegment === undefined) return null;
    const sequence = Number.parseInt(cleaned, 10);
    if (sequence <= 0) return null;
    return formatPublicId(sequence, defaultSegment, padForSegment(defaultSegment));
  }

  const direct = parsePublicId(cleaned);
  if (direct !== null) {
    return formatPublicId(direct.sequence, direct.segment, padForSegment(direct.segment));
  }

  // Missing the XN prefix, e.g. `WL-1842`.
  const withPrefix = parsePublicId(`${PUBLIC_ID_PREFIX}-${cleaned}`);
  if (withPrefix !== null) {
    return formatPublicId(
      withPrefix.sequence,
      withPrefix.segment,
      padForSegment(withPrefix.segment),
    );
  }

  return null;
}
