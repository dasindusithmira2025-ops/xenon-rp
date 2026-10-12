import { z } from 'zod';

import { discordSnowflake, integrationEventSchema } from './events';

/**
 * Xenon Link gateway — the narrow Discord surface the background worker uses.
 *
 * The worker owns the job queue and the database; Link owns the Discord token.
 * Instead of giving the worker a bot token (or Link a database credential),
 * the worker asks Link to perform one of these operations:
 *
 *   `POST {LINK_GATEWAY_URL}/gateway/v1/<operation>`, signed as service `worker`
 *   (transport `http`), or the same signed envelope carried through Redis and
 *   pulled by Link from Core over outbound HTTPS (transport `relay`, see
 *   link-relay.ts). Both transports run the same Link handlers.
 *
 * Link enforces its own limits regardless of what the worker asks for:
 *  - only the configured guild and its channels;
 *  - never a role that carries a privileged permission, `@everyone`, or a
 *    role managed by an integration (see `PRIVILEGED_ROLE_PERMISSIONS`);
 *  - mentions are suppressed except explicitly allowed role pings.
 *
 * Errors report Discord's numeric code when there is one, so the worker's
 * existing classification (50013 missing permission, 10011 unknown role,
 * 10007 unknown member, 50007 DMs closed) keeps working unchanged.
 */

export const LINK_GATEWAY_PREFIX = '/gateway/v1';

/** Largest gateway request body, in UTF-8 bytes, on either transport. */
export const GATEWAY_BODY_LIMIT_BYTES = 64 * 1024;

/** A Discord message body. Embeds and components are Discord API JSON. */
export const discordMessage = z
  .object({
    content: z.string().max(2000).optional(),
    embeds: z.array(z.record(z.string(), z.unknown())).max(10).optional(),
    components: z.array(z.record(z.string(), z.unknown())).max(5).optional(),
    /** Role snowflakes this message may ping. Everything else is suppressed. */
    allowedRoleMentions: z.array(discordSnowflake).max(5).optional(),
  })
  .refine(
    (message) =>
      (message.content?.length ?? 0) > 0 ||
      (message.embeds?.length ?? 0) > 0 ||
      (message.components?.length ?? 0) > 0,
    'A message needs content, an embed or a component',
  );
export type DiscordMessageBody = z.output<typeof discordMessage>;

export const gatewayOperations = {
  /** Role snowflakes a member holds, or null when they are not in the guild. */
  'member.roles': {
    input: z.object({ discordUserId: discordSnowflake }),
    output: z.object({ roleIds: z.array(discordSnowflake).nullable() }),
  },
  'member.role': {
    input: z.object({
      discordUserId: discordSnowflake,
      roleId: discordSnowflake,
      action: z.enum(['add', 'remove']),
      reason: z.string().trim().min(1).max(200),
    }),
    output: z.object({ changed: z.boolean() }),
  },
  'role.inspect': {
    input: z.object({ roleId: discordSnowflake }),
    output: z.object({
      roleFound: z.boolean(),
      hierarchyBlocked: z.boolean(),
      manageRolesMissing: z.boolean(),
      /** The role carries a permission Link refuses to grant. */
      privileged: z.boolean(),
    }),
  },
  'member.snapshot': {
    input: z.object({ discordUserId: discordSnowflake }),
    output: z.object({
      member: z
        .object({
          nickname: z.string().nullable(),
          joinedAt: z.iso.datetime().nullable(),
          roleIds: z.array(discordSnowflake),
          pendingScreening: z.boolean(),
        })
        .nullable(),
    }),
  },
  'guild.info': {
    input: z.object({}),
    output: z.object({
      guildId: discordSnowflake,
      name: z.string(),
      iconUrl: z.string().nullable(),
      memberCount: z.number().int().min(0),
    }),
  },
  'message.send': {
    input: z.object({
      target: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('channel'), channelId: discordSnowflake }),
        z.object({ kind: z.literal('dm'), discordUserId: discordSnowflake }),
      ]),
      message: discordMessage,
    }),
    output: z.object({ channelId: discordSnowflake, messageId: discordSnowflake }),
  },
  /** Edit a message Link sent earlier. `found: false` when it no longer exists. */
  'message.edit': {
    input: z.object({
      channelId: discordSnowflake,
      messageId: discordSnowflake,
      message: discordMessage,
    }),
    output: z.object({ found: z.boolean() }),
  },
  /** Deliver an integration event for Link to project into Discord. */
  'events.deliver': {
    input: integrationEventSchema,
    output: z.object({ accepted: z.boolean() }),
  },
} as const;

export type GatewayOperation = keyof typeof gatewayOperations;
export type GatewayInput<TOp extends GatewayOperation> = z.input<
  (typeof gatewayOperations)[TOp]['input']
>;
export type GatewayOutput<TOp extends GatewayOperation> = z.output<
  (typeof gatewayOperations)[TOp]['output']
>;

export const GATEWAY_OPERATIONS = Object.keys(gatewayOperations) as GatewayOperation[];

export const GATEWAY_ERROR_CODES = [
  /** Not ready, rate limited, or a 5xx from Discord. Retry later. */
  'DISCORD_UNAVAILABLE',
  /** Discord refused the call; `discordCode` says why. */
  'DISCORD_ERROR',
  /** Link's own policy refused the target (other guild, privileged role, …). */
  'FORBIDDEN_TARGET',
  'VALIDATION',
  'UNAUTHENTICATED',
] as const;
export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[number];

export type GatewayResponse<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: GatewayErrorCode;
        readonly message: string;
        readonly retryable: boolean;
        readonly discordCode?: number;
      };
    };

export const gatewayErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.enum(GATEWAY_ERROR_CODES),
    message: z.string().max(2000),
    retryable: z.boolean(),
    discordCode: z.number().int().optional(),
  }),
});

/**
 * Discord permission flag names a Link-managed role may never carry. A role
 * mapping that points at one of these is refused, so a misconfigured mapping
 * (or a compromised worker) cannot turn role sync into privilege escalation.
 */
export const PRIVILEGED_ROLE_PERMISSIONS = [
  'Administrator',
  'ManageGuild',
  'ManageRoles',
  'ManageChannels',
  'ManageWebhooks',
  'ManageGuildExpressions',
  'ManageEvents',
  'ManageThreads',
  'ManageMessages',
  'ManageNicknames',
  'KickMembers',
  'BanMembers',
  'ModerateMembers',
  'MentionEveryone',
  'ViewAuditLog',
  'MoveMembers',
  'MuteMembers',
  'DeafenMembers',
] as const;
