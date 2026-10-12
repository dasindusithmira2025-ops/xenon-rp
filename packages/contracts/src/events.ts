import { z } from 'zod';

/**
 * Cross-platform integration events.
 *
 * An event records something that already happened in the authoritative store
 * (Postgres, through the Xenon domain services). It is written to the outbox in
 * the same transaction as the decision it describes, then relayed to each
 * subscriber. Consumers never treat an event as a command to re-decide
 * anything: they project it (post a notice, refresh a card, reconcile a role).
 *
 * Every event is versioned. A breaking payload change adds a new version
 * rather than mutating an old one, so a consumer that has not been redeployed
 * rejects what it cannot understand instead of misreading it.
 *
 * Payloads carry public identifiers (`XN-…`) and Discord snowflakes only.
 * Game identifiers (Rockstar licences, Steam ids) never leave Core in an event.
 */

export const discordSnowflake = z.string().regex(/^\d{17,20}$/, 'Expected a Discord snowflake');
export const playerPublicId = z.string().regex(/^XN-[A-Z0-9-]{1,32}$/, 'Expected a Xenon id');
const shortText = (max: number) => z.string().trim().max(max);

export const ACTION_SOURCES = ['WEB', 'DISCORD', 'FIVEM', 'SYSTEM'] as const;
export const actionSource = z.enum(ACTION_SOURCES);

/** Identity kinds the game server can report. Only some are trusted for admission. */
export const GAME_IDENTITY_KINDS = [
  'LICENSE',
  'LICENSE2',
  'STEAM',
  'DISCORD',
  'FIVEM',
  'XBL',
  'LIVE',
] as const;
export const gameIdentityKind = z.enum(GAME_IDENTITY_KINDS);

/**
 * Identifier kinds FXServer verifies itself (Rockstar licence and Cfx.re
 * account). Anything else is reported by the client and can be spoofed, so it
 * never proves who is connecting.
 */
export const TRUSTED_IDENTITY_KINDS = ['LICENSE', 'LICENSE2', 'FIVEM'] as const;
export type TrustedIdentityKind = (typeof TRUSTED_IDENTITY_KINDS)[number];

export function isTrustedIdentityKind(kind: string): kind is TrustedIdentityKind {
  return (TRUSTED_IDENTITY_KINDS as readonly string[]).includes(kind);
}

const payloads = {
  WHITELIST_SUBMITTED: z.object({
    playerPublicId,
    discordId: discordSnowflake.nullable(),
    applicationPublicId: shortText(40),
    templateName: shortText(120),
  }),
  WHITELIST_APPROVED: z.object({
    playerPublicId,
    discordId: discordSnowflake.nullable(),
    /** Null when staff granted the whitelist directly rather than through an application. */
    applicationPublicId: shortText(40).nullable(),
  }),
  WHITELIST_REJECTED: z.object({
    playerPublicId,
    discordId: discordSnowflake.nullable(),
    applicationPublicId: shortText(40),
  }),
  WHITELIST_REVOKED: z.object({
    playerPublicId,
    discordId: discordSnowflake.nullable(),
    state: z.enum(['REVOKED', 'SUSPENDED']),
  }),
  PLAYER_IDENTITY_LINKED: z.object({
    playerPublicId,
    discordId: discordSnowflake.nullable(),
    kinds: z.array(gameIdentityKind).min(1).max(GAME_IDENTITY_KINDS.length),
    /** CFX: verified on the website via Cfx.re authorization. STAFF: staff exception. */
    via: z.enum(['CFX', 'STAFF']),
  }),
  PLAYER_CONNECTED: z.object({
    serverSlug: shortText(64),
    playerPublicId: playerPublicId.nullable(),
    playerName: shortText(64),
  }),
  PLAYER_DISCONNECTED: z.object({
    serverSlug: shortText(64),
    playerPublicId: playerPublicId.nullable(),
    playerName: shortText(64),
    reason: shortText(200),
  }),
  SERVER_STATUS_CHANGED: z.object({
    serverSlug: shortText(64),
    serverName: shortText(120),
    previousOnline: z.boolean().nullable(),
    online: z.boolean(),
    playerCount: z.number().int().min(0).nullable(),
    maxPlayers: z.number().int().min(0).nullable(),
  }),
  SERVER_RESTART_SCHEDULED: z.object({
    serverSlug: shortText(64),
    restartAt: z.iso.datetime(),
    secondsRemaining: z
      .number()
      .int()
      .min(0)
      .max(24 * 60 * 60),
    origin: z.enum(['TXADMIN', 'STAFF']),
  }),
  PLAYER_SUSPENDED: z.object({
    playerPublicId,
    discordId: discordSnowflake.nullable(),
    until: z.iso.datetime().nullable(),
    reason: shortText(500),
  }),
  PLAYER_BANNED: z.object({
    playerPublicId: playerPublicId.nullable(),
    discordId: discordSnowflake.nullable(),
    /** PLATFORM: the Xenon account itself. FIVEM: a game-server ban (e.g. txAdmin). */
    scope: z.enum(['PLATFORM', 'FIVEM']),
    reason: shortText(500),
    expiresAt: z.iso.datetime().nullable(),
    /** Moderation case created for this ban, when Core recorded one. */
    caseId: shortText(40).nullable(),
  }),
  ROLE_SYNC_REQUESTED: z.object({
    playerPublicId,
    reason: shortText(120),
  }),
  ROLE_SYNC_FAILED: z.object({
    playerPublicId,
    discordId: discordSnowflake.nullable(),
    errors: z.array(shortText(200)).min(1).max(10),
  }),
} as const;

export type IntegrationEventType = keyof typeof payloads;
export const INTEGRATION_EVENT_TYPES = Object.keys(payloads) as IntegrationEventType[];

/** Current schema version of every event type. Bump when a payload changes shape. */
export const EVENT_VERSIONS: Readonly<Record<IntegrationEventType, number>> = Object.fromEntries(
  INTEGRATION_EVENT_TYPES.map((type) => [type, 1]),
) as Record<IntegrationEventType, number>;

export type IntegrationEventPayload<TType extends IntegrationEventType> = z.output<
  (typeof payloads)[TType]
>;

const envelopeBase = {
  /** Outbox row id. Stable across retries; consumers de-duplicate on it. */
  id: z.string().min(1).max(64),
  /** Caller-chosen key. Two emissions with the same key collapse into one event. */
  idempotencyKey: z.string().min(1).max(200),
  occurredAt: z.iso.datetime(),
  source: actionSource,
};

const envelopes = INTEGRATION_EVENT_TYPES.map((type) =>
  z.object({
    ...envelopeBase,
    type: z.literal(type),
    version: z.literal(EVENT_VERSIONS[type]),
    payload: payloads[type],
  }),
);

export const integrationEventSchema = z.discriminatedUnion(
  'type',
  envelopes as [(typeof envelopes)[number], ...(typeof envelopes)[number][]],
);

export type IntegrationEvent = {
  [TType in IntegrationEventType]: {
    readonly id: string;
    readonly idempotencyKey: string;
    readonly occurredAt: string;
    readonly source: (typeof ACTION_SOURCES)[number];
    readonly type: TType;
    readonly version: number;
    readonly payload: IntegrationEventPayload<TType>;
  };
}[IntegrationEventType];

/** Validate an untrusted envelope (e.g. one received over the network). */
export function parseIntegrationEvent(
  raw: unknown,
): { ok: true; event: IntegrationEvent } | { ok: false; error: string } {
  const result = integrationEventSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, error: result.error.issues[0]?.message ?? 'Invalid event' };
  }
  return { ok: true, event: result.data as IntegrationEvent };
}

/** Validate a payload before it is written to the outbox. Throws on a programming error. */
export function validateEventPayload<TType extends IntegrationEventType>(
  type: TType,
  payload: IntegrationEventPayload<TType>,
): IntegrationEventPayload<TType> {
  return payloads[type].parse(payload) as IntegrationEventPayload<TType>;
}

/**
 * Who receives each event. The relay fans an event out to one delivery per
 * subscriber, each with its own retry and receipt, so a slow consumer never
 * blocks another. Guardian is deliberately absent: it consumes nothing from
 * the platform and must keep working when the platform is down.
 */
export const EVENT_SUBSCRIBERS = ['link'] as const;
export type EventSubscriber = (typeof EVENT_SUBSCRIBERS)[number];

export const SUBSCRIPTIONS: Readonly<Record<IntegrationEventType, readonly EventSubscriber[]>> = {
  WHITELIST_SUBMITTED: ['link'],
  WHITELIST_APPROVED: ['link'],
  WHITELIST_REJECTED: ['link'],
  WHITELIST_REVOKED: ['link'],
  PLAYER_IDENTITY_LINKED: ['link'],
  // Connect/disconnect are recorded for audit and diagnostics; no consumer
  // needs a Discord message per connection.
  PLAYER_CONNECTED: [],
  PLAYER_DISCONNECTED: [],
  SERVER_STATUS_CHANGED: ['link'],
  SERVER_RESTART_SCHEDULED: ['link'],
  PLAYER_SUSPENDED: ['link'],
  PLAYER_BANNED: ['link'],
  ROLE_SYNC_REQUESTED: [],
  ROLE_SYNC_FAILED: ['link'],
};
