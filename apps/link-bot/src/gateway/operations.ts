import {
  DiscordAPIError,
  HTTPError,
  PermissionFlagsBits,
  RateLimitError,
  type Client,
  type Guild,
  type GuildMember,
  type MessageCreateOptions,
  type Role,
  type SendableChannels,
} from 'discord.js';

import {
  PRIVILEGED_ROLE_PERMISSIONS,
  type DiscordMessageBody,
  type GatewayErrorCode,
  type GatewayOperation,
  type GatewayOutput,
  type IntegrationEvent,
  type gatewayOperations,
} from '@xenon/contracts';
import type { Logger } from '@xenon/logger';

import { createEventProjector } from './events';

import type { z } from 'zod';

/**
 * The Discord side of the Link gateway.
 *
 * The worker decides *what* should happen (which roles a member should hold,
 * which DM to send); Link decides whether it is allowed to happen. Every
 * policy below is enforced here regardless of the request, so a compromised or
 * misconfigured worker can do no more than Link itself would:
 *
 *  - only the configured guild, and only text channels inside it (or DMs);
 *  - never `@everyone`, an integration-managed role, or a role carrying a
 *    permission in `PRIVILEGED_ROLE_PERMISSIONS`;
 *  - no mention is ever parsed from content; only explicitly listed role pings.
 */

export type GatewayInputOf<TOp extends GatewayOperation> = z.output<
  (typeof gatewayOperations)[TOp]['input']
>;

export class GatewayFailure extends Error {
  constructor(
    readonly code: GatewayErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly discordCode?: number,
  ) {
    super(message);
    this.name = 'GatewayFailure';
  }
}

const UNKNOWN_ROLE = 10011;
const UNKNOWN_MEMBER = 10007;
const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_MESSAGE = 10008;
const MISSING_PERMISSIONS = 50013;

const PRIVILEGED_BITS = PRIVILEGED_ROLE_PERMISSIONS.map((name) => PermissionFlagsBits[name]);

/** Translate anything thrown while talking to Discord into the gateway's error vocabulary. */
export function toGatewayFailure(error: unknown): GatewayFailure {
  if (error instanceof GatewayFailure) return error;
  if (error instanceof DiscordAPIError) {
    if (error.status >= 500 || error.status === 429) {
      return new GatewayFailure('DISCORD_UNAVAILABLE', 'Discord is unavailable.', true);
    }
    const code = typeof error.code === 'number' ? error.code : undefined;
    return new GatewayFailure(
      'DISCORD_ERROR',
      `Discord refused the request${code === undefined ? '' : ` (${String(code)})`}.`,
      false,
      code,
    );
  }
  if (error instanceof HTTPError || error instanceof RateLimitError) {
    return new GatewayFailure('DISCORD_UNAVAILABLE', 'Discord is unavailable.', true);
  }
  return new GatewayFailure('DISCORD_UNAVAILABLE', 'The Discord request failed.', true);
}

function discordCodeOf(error: unknown): number | null {
  return error instanceof DiscordAPIError && typeof error.code === 'number' ? error.code : null;
}

/** Why Link refuses to manage a role, or null when it may. */
export function roleRefusal(role: Role, guildId: string): string | null {
  if (role.id === guildId) return 'Link never manages @everyone.';
  if (role.managed) return 'Link never manages a role owned by an integration.';
  if (role.permissions.any(PRIVILEGED_BITS)) {
    return 'Link never manages a role that carries a privileged permission.';
  }
  return null;
}

export function toMessagePayload(
  message: DiscordMessageBody,
  guildId: string,
): MessageCreateOptions {
  return {
    ...(message.content === undefined ? {} : { content: message.content }),
    ...(message.embeds === undefined ? {} : { embeds: message.embeds }),
    ...(message.components === undefined
      ? {}
      : { components: message.components as unknown as MessageCreateOptions['components'] }),
    allowedMentions: {
      parse: [],
      roles: (message.allowedRoleMentions ?? []).filter((roleId) => roleId !== guildId),
    },
  };
}

export interface GatewayDependencies {
  readonly client: Client;
  readonly guildId: string;
  readonly eventsChannelId: string | undefined;
  readonly staffLogChannelId: string | undefined;
  readonly logger: Logger;
}

export type GatewayHandlers = {
  readonly [TOp in GatewayOperation]: (input: GatewayInputOf<TOp>) => Promise<GatewayOutput<TOp>>;
};

export function createGatewayOperations(deps: GatewayDependencies): GatewayHandlers {
  const { client, guildId } = deps;

  async function readyGuild(): Promise<Guild> {
    if (!client.isReady()) {
      throw new GatewayFailure('DISCORD_UNAVAILABLE', 'The Discord gateway is not ready.', true);
    }
    return client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId));
  }

  async function fetchMember(guild: Guild, discordUserId: string): Promise<GuildMember | null> {
    try {
      return await guild.members.fetch({ user: discordUserId, force: true });
    } catch (error) {
      // Unknown Member: they left the guild. A normal state, not a failure.
      if (discordCodeOf(error) === UNKNOWN_MEMBER) return null;
      throw error;
    }
  }

  async function inspectRole(guild: Guild, roleId: string) {
    const role = await guild.roles.fetch(roleId);
    if (role === null) return null;
    const me = guild.members.me ?? (await guild.members.fetchMe());
    return {
      role,
      privileged: roleRefusal(role, guildId) !== null,
      // A role at or above Link's highest role is unmanageable whatever its permissions.
      hierarchyBlocked: me.roles.highest.comparePositionTo(role) <= 0,
      manageRolesMissing: !me.permissions.has(PermissionFlagsBits.ManageRoles),
    };
  }

  /** A text channel inside the configured guild; anything else is refused. */
  async function guildTextChannel(channelId: string): Promise<SendableChannels> {
    const channel = await client.channels.fetch(channelId);
    if (channel === null) {
      throw new GatewayFailure('DISCORD_ERROR', 'Unknown channel.', false, UNKNOWN_CHANNEL);
    }
    if (channel.isDMBased() || channel.guildId !== guildId) {
      throw new GatewayFailure(
        'FORBIDDEN_TARGET',
        'That channel is outside the Xenon guild.',
        false,
      );
    }
    if (!channel.isTextBased() || !channel.isSendable()) {
      throw new GatewayFailure('FORBIDDEN_TARGET', 'That channel cannot hold messages.', false);
    }
    return channel;
  }

  async function sendToChannel(channelId: string, message: DiscordMessageBody) {
    await readyGuild();
    const channel = await guildTextChannel(channelId);
    const sent = await channel.send(toMessagePayload(message, guildId));
    return { channelId: sent.channelId, messageId: sent.id };
  }

  const projector = createEventProjector({
    eventsChannelId: deps.eventsChannelId,
    staffLogChannelId: deps.staffLogChannelId,
    send: sendToChannel,
    logger: deps.logger,
  });

  return {
    async 'member.roles'({ discordUserId }) {
      const member = await fetchMember(await readyGuild(), discordUserId);
      return { roleIds: member === null ? null : [...member.roles.cache.keys()] };
    },

    async 'member.role'({ discordUserId, roleId, action, reason }) {
      const guild = await readyGuild();
      const inspected = await inspectRole(guild, roleId);
      if (inspected === null) {
        throw new GatewayFailure('DISCORD_ERROR', 'Unknown role.', false, UNKNOWN_ROLE);
      }
      const refusal = roleRefusal(inspected.role, guildId);
      if (refusal !== null) throw new GatewayFailure('FORBIDDEN_TARGET', refusal, false);
      if (inspected.manageRolesMissing || inspected.hierarchyBlocked) {
        throw new GatewayFailure(
          'DISCORD_ERROR',
          inspected.manageRolesMissing
            ? 'Link is missing Manage Roles.'
            : 'The role is above Link in the role hierarchy.',
          false,
          MISSING_PERMISSIONS,
        );
      }

      const member = await fetchMember(guild, discordUserId);
      if (member === null) {
        throw new GatewayFailure('DISCORD_ERROR', 'Unknown member.', false, UNKNOWN_MEMBER);
      }
      const holds = member.roles.cache.has(roleId);
      if (action === 'add' && !holds) {
        await member.roles.add(roleId, reason);
        return { changed: true };
      }
      if (action === 'remove' && holds) {
        await member.roles.remove(roleId, reason);
        return { changed: true };
      }
      return { changed: false };
    },

    async 'role.inspect'({ roleId }) {
      const inspected = await inspectRole(await readyGuild(), roleId);
      if (inspected === null) {
        return {
          roleFound: false,
          hierarchyBlocked: false,
          manageRolesMissing: false,
          privileged: false,
        };
      }
      return {
        roleFound: true,
        hierarchyBlocked: inspected.hierarchyBlocked,
        manageRolesMissing: inspected.manageRolesMissing,
        privileged: inspected.privileged,
      };
    },

    async 'member.snapshot'({ discordUserId }) {
      const member = await fetchMember(await readyGuild(), discordUserId);
      if (member === null) return { member: null };
      return {
        member: {
          nickname: member.nickname,
          joinedAt: member.joinedAt?.toISOString() ?? null,
          roleIds: [...member.roles.cache.keys()],
          pendingScreening: member.pending,
        },
      };
    },

    async 'guild.info'() {
      const guild = await readyGuild();
      return {
        guildId: guild.id,
        name: guild.name,
        iconUrl: guild.iconURL(),
        memberCount: guild.memberCount,
      };
    },

    async 'message.send'({ target, message }) {
      if (target.kind === 'channel') return sendToChannel(target.channelId, message);
      await readyGuild();
      const user = await client.users.fetch(target.discordUserId);
      const dm = await user.createDM();
      const sent = await dm.send(toMessagePayload(message, guildId));
      return { channelId: sent.channelId, messageId: sent.id };
    },

    async 'message.edit'({ channelId, messageId, message }) {
      await readyGuild();
      let channel;
      try {
        channel = await client.channels.fetch(channelId);
      } catch (error) {
        if (discordCodeOf(error) === UNKNOWN_CHANNEL) return { found: false };
        throw error;
      }
      if (channel === null) return { found: false };
      // DMs are Link's own conversations; guild channels must be in our guild.
      if (!channel.isDMBased() && channel.guildId !== guildId) {
        throw new GatewayFailure(
          'FORBIDDEN_TARGET',
          'That channel is outside the Xenon guild.',
          false,
        );
      }
      if (!channel.isTextBased()) {
        throw new GatewayFailure('FORBIDDEN_TARGET', 'That channel cannot hold messages.', false);
      }

      let existing;
      try {
        existing = await channel.messages.fetch(messageId);
      } catch (error) {
        if (discordCodeOf(error) === UNKNOWN_MESSAGE) return { found: false };
        throw error;
      }
      // Link only edits what Link wrote: another bot's or a member's message is "not found".
      if (existing.author.id !== client.user?.id) return { found: false };

      const payload = toMessagePayload(message, guildId);
      await existing.edit({
        ...(payload.content === undefined ? {} : { content: payload.content }),
        ...(payload.embeds === undefined ? {} : { embeds: payload.embeds }),
        ...(payload.components === undefined ? {} : { components: payload.components }),
        allowedMentions: payload.allowedMentions,
      });
      return { found: true };
    },

    // Schema-validated by the server; zod's union output loses the type↔payload
    // correlation that `IntegrationEvent` expresses (see `parseIntegrationEvent`).
    'events.deliver': (event) => projector.deliver(event as IntegrationEvent),
  };
}
