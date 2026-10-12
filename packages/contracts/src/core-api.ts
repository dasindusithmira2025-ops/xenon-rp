import { z } from 'zod';

import { discordSnowflake } from './events';
import { linkRelayOperations, type RelayOperation } from './link-relay';

/**
 * Xenon Core API — the internal contract Xenon Link calls.
 *
 * Link holds no database or Redis credential. Every read and every decision
 * goes through these operations, which run the same domain services the
 * website uses, so a staff approval from a Discord button and one from
 * /control are the same code path with a different `source` on the audit row.
 *
 * Transport: `POST {CORE_API_URL}/internal/v1/<operation>` with a JSON body,
 * signed as service `link` (see service-auth.ts). Responses use
 * {@link CoreResponse}. The `relay.*` operations are Link's outbound pull
 * channel for worker gateway requests (see link-relay.ts).
 *
 * `actorDiscordId` is the Discord user who triggered the interaction. Link is
 * trusted to report it truthfully (Discord signs interactions to Link), and
 * Core resolves capabilities from the database — never from Discord roles.
 */

export const CORE_API_PREFIX = '/internal/v1';

const actor = { actorDiscordId: discordSnowflake };
const reference = z.string().trim().min(1).max(64);
const note = z.string().trim().max(1800);

const applicationStatusView = z.object({
  reference: z.string(),
  status: z.string(),
  statusLabel: z.string(),
});

export const coreOperations = {
  'status.board': {
    input: z.object({}),
    output: z.object({
      aggregate: z.string(),
      checkedAt: z.iso.datetime().nullable(),
      connectUrl: z.string().nullable(),
      servers: z.array(
        z.object({
          name: z.string(),
          state: z.string(),
          playerCount: z.number().int().nullable(),
          maxPlayers: z.number().int().nullable(),
          queueLength: z.number().int().nullable(),
        }),
      ),
    }),
  },
  'players.profile': {
    input: z.object({ ...actor, targetDiscordId: discordSnowflake }),
    /** Null: the target has no Xenon account. */
    output: z
      .object({
        publicId: z.string(),
        displayName: z.string().nullable(),
        whitelistState: z.string(),
        accountStatus: z.string(),
        /** An active, verified Cfx.re (FiveM) account is linked. */
        fivemLinked: z.boolean(),
        cfxUsername: z.string().nullable(),
        characters: z.number().int(),
        applications: z.number().int(),
        joinedAt: z.iso.datetime(),
      })
      .nullable(),
  },
  'players.lookup': {
    input: z.object({ ...actor, reference }),
    output: z
      .object({
        publicId: z.string(),
        displayName: z.string().nullable(),
        whitelistState: z.string(),
        accountStatus: z.string(),
      })
      .nullable(),
  },
  'whitelist.status': {
    input: z.object(actor),
    output: z.object({
      hasAccount: z.boolean(),
      state: z.string().nullable(),
      reason: z.string().nullable(),
      fivemLinked: z.boolean(),
      latestApplication: applicationStatusView.nullable(),
    }),
  },
  'applications.own': {
    input: z.object({ ...actor, reference: reference.optional() }),
    output: z
      .object({
        reference: z.string(),
        templateName: z.string(),
        status: z.string(),
        statusLabel: z.string(),
      })
      .nullable(),
  },
  'applications.queue': {
    input: z.object(actor),
    output: z.object({
      total: z.number().int(),
      items: z.array(
        z.object({
          reference: z.string(),
          applicant: z.string(),
          templateName: z.string(),
          submittedAt: z.iso.datetime().nullable(),
        }),
      ),
    }),
  },
  /** Re-post or refresh the staff review card. The worker delivers it through Link. */
  'applications.refreshCard': {
    input: z.object({ ...actor, reference }),
    output: z.object({ queued: z.boolean() }),
  },
  /** Can the actor take this review action? Used before opening a modal. */
  'applications.authorize': {
    input: z.object({ ...actor, action: z.enum(['reject', 'changes', 'interview']) }),
    output: z.object({ allowed: z.boolean() }),
  },
  'applications.decide': {
    input: z.discriminatedUnion('action', [
      z.object({ ...actor, reference, action: z.literal('claim') }),
      z.object({ ...actor, reference, action: z.literal('approve') }),
      z.object({
        ...actor,
        reference,
        action: z.literal('reject'),
        publicNote: note.min(10),
        staffNote: note,
      }),
      z.object({
        ...actor,
        reference,
        action: z.literal('changes'),
        publicNote: note.min(10),
        staffNote: note,
      }),
      z.object({
        ...actor,
        reference,
        action: z.literal('interview'),
        publicNote: note,
        staffNote: note,
      }),
    ]),
    output: applicationStatusView,
  },
  /**
   * The actor's Cfx.re link, for `/link`. Linking itself happens only on the
   * website (Cfx.re authorization); Link never creates or changes a link.
   */
  'link.status': {
    input: z.object(actor),
    output: z.object({
      hasAccount: z.boolean(),
      linked: z.boolean(),
      cfxUsername: z.string().nullable(),
      linkedAt: z.iso.datetime().nullable(),
      verifiedOnWebsite: z.boolean(),
    }),
  },
  /** Queue a Discord role reconciliation. Self always; others need `discord.manage`. */
  'roles.sync': {
    input: z.object({ ...actor, targetDiscordId: discordSnowflake.optional() }),
    output: z.object({ queued: z.boolean(), playerPublicId: z.string() }),
  },
  /** Close the actor's own website ticket from its Discord DM panel. */
  'tickets.closeOwn': {
    input: z.object({ ...actor, ticketPublicId: reference }),
    output: z.object({ publicId: z.string() }),
  },
  ...linkRelayOperations,
} as const;

/** Operations served by Core's domain handlers (everything except the Link relay). */
export type CoreDomainOperation = Exclude<CoreOperation, RelayOperation>;

export type CoreOperation = keyof typeof coreOperations;
export type CoreInput<TOp extends CoreOperation> = z.input<(typeof coreOperations)[TOp]['input']>;
export type CoreOutput<TOp extends CoreOperation> = z.output<
  (typeof coreOperations)[TOp]['output']
>;

export const CORE_OPERATIONS = Object.keys(coreOperations) as CoreOperation[];

/**
 * Error codes, one per `@xenon/core` error class plus transport failures.
 * `message` is always the error's `safeMessage`: Core never sends internal
 * detail across the boundary.
 */
export const CORE_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'VALIDATION',
  'RATE_LIMITED',
  'INTEGRATION',
  'INTERNAL',
] as const;
export type CoreErrorCode = (typeof CORE_ERROR_CODES)[number];

export const CORE_ERROR_STATUS: Readonly<Record<CoreErrorCode, number>> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION: 422,
  RATE_LIMITED: 429,
  INTEGRATION: 502,
  INTERNAL: 500,
};

export type CoreResponse<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: CoreErrorCode;
        readonly message: string;
        readonly retryAfterSeconds?: number;
      };
    };

export const coreErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.enum(CORE_ERROR_CODES),
    message: z.string().max(2000),
    retryAfterSeconds: z.number().int().min(0).optional(),
  }),
});
