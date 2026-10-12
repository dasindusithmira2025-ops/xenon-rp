import {
  AutoModerationActionType,
  AutoModerationRuleEventType,
  AutoModerationRuleTriggerType,
  ChannelType,
  DiscordAPIError,
  type Guild,
  type GuildBasedChannel,
  OverwriteType,
} from 'discord.js';

import type {
  AutoModPayload,
  GuildAdapter,
  GuildSnapshot,
  Overwrite,
  SnapshotChannel,
} from '@xenon/discord/provisioning';

/**
 * `GuildAdapter` over a real discord.js guild.
 *
 * The only file in the provisioning path that knows discord.js exists. It
 * translates between the engine's plain data and Discord's API shapes, and
 * every audit-log reason names Xenon so a human reading the server audit log
 * knows exactly what made each change.
 */

const REASON = 'Xenon provisioning';

const kindOf: Partial<Record<ChannelType, SnapshotChannel['kind']>> = {
  [ChannelType.GuildCategory]: 'category',
  [ChannelType.GuildText]: 'text',
  [ChannelType.GuildAnnouncement]: 'announcement',
  [ChannelType.GuildForum]: 'forum',
  [ChannelType.GuildVoice]: 'voice',
};

const typeOf = {
  category: ChannelType.GuildCategory,
  text: ChannelType.GuildText,
  announcement: ChannelType.GuildAnnouncement,
  forum: ChannelType.GuildForum,
  voice: ChannelType.GuildVoice,
} as const;

function isMissing(error: unknown, ...codes: number[]): boolean {
  return (
    error instanceof DiscordAPIError && typeof error.code === 'number' && codes.includes(error.code)
  );
}

function toOverwrites(overwrites: readonly Overwrite[]) {
  return overwrites.map((overwrite) => ({
    id: overwrite.id,
    type: overwrite.type === 'role' ? OverwriteType.Role : OverwriteType.Member,
    allow: overwrite.allow,
    deny: overwrite.deny,
  }));
}

function snapshotChannel(channel: GuildBasedChannel): SnapshotChannel | null {
  if (channel.isThread()) return null;
  const kind = kindOf[channel.type] ?? 'other';
  return {
    id: channel.id,
    name: channel.name,
    kind,
    parentId: channel.parentId,
    position: 'rawPosition' in channel ? channel.rawPosition : 0,
    topic: 'topic' in channel ? (channel.topic ?? null) : null,
    overwrites: channel.permissionOverwrites.cache.map((overwrite) => ({
      id: overwrite.id,
      type: overwrite.type === OverwriteType.Role ? ('role' as const) : ('member' as const),
      allow: overwrite.allow.bitfield,
      deny: overwrite.deny.bitfield,
    })),
    ...('userLimit' in channel ? { userLimit: channel.userLimit } : {}),
    ...('rateLimitPerUser' in channel && typeof channel.rateLimitPerUser === 'number'
      ? { slowmodeSeconds: channel.rateLimitPerUser }
      : {}),
  };
}

async function textChannel(guild: Guild, id: string) {
  const channel = await guild.channels.fetch(id);
  if (channel === null || !channel.isTextBased() || channel.isThread()) {
    throw new Error(`Channel ${id} cannot hold messages`);
  }
  return channel;
}

function automodCreateOptions(payload: AutoModPayload) {
  const actions = [
    {
      type: AutoModerationActionType.BlockMessage,
      metadata: {
        customMessage: 'Blocked by XenonRP safety rules. Contact staff if this was a mistake.',
      },
    },
    ...(payload.alertChannelId === null
      ? []
      : [
          {
            type: AutoModerationActionType.SendAlertMessage,
            metadata: { channel: payload.alertChannelId },
          },
        ]),
  ];
  const trigger = payload.trigger;
  return {
    name: payload.name,
    eventType: AutoModerationRuleEventType.MessageSend,
    triggerType:
      trigger.type === 'mention-spam'
        ? AutoModerationRuleTriggerType.MentionSpam
        : trigger.type === 'keyword'
          ? AutoModerationRuleTriggerType.Keyword
          : AutoModerationRuleTriggerType.Spam,
    triggerMetadata:
      trigger.type === 'mention-spam'
        ? { mentionTotalLimit: trigger.limit, mentionRaidProtectionEnabled: true }
        : trigger.type === 'keyword'
          ? { regexPatterns: trigger.regex }
          : {},
    // The Spam trigger only supports blocking; alerts are for the others.
    actions: trigger.type === 'spam' ? actions.slice(0, 1) : actions,
    exemptRoles: payload.exemptRoleIds,
    enabled: true,
    reason: REASON,
  };
}

export function discordGuildAdapter(guild: Guild): GuildAdapter {
  return {
    async snapshot(panelRefs) {
      const [roles, channels, emojis, stickers, me] = await Promise.all([
        guild.roles.fetch(),
        guild.channels.fetch(),
        guild.emojis.fetch(),
        guild.stickers.fetch(),
        guild.members.fetchMe(),
      ]);

      const panelMessages = new Set<string>();
      for (const ref of panelRefs) {
        try {
          const channel = await textChannel(guild, ref.channelId);
          await channel.messages.fetch(ref.messageId);
          panelMessages.add(`${ref.channelId}:${ref.messageId}`);
        } catch (error) {
          // Unknown channel / message / access: the panel is gone, which the
          // plan reports as drift. Anything else is a real failure.
          if (
            !isMissing(error, 10003, 10008, 50001) &&
            !(error instanceof Error && error.message.includes('cannot hold'))
          ) {
            throw error;
          }
        }
      }

      // AutoMod needs Manage Server to read. Without it the plan still works;
      // it just cannot see existing rules.
      let automodRules: GuildSnapshot['automodRules'] = [];
      try {
        const rules = await guild.autoModerationRules.fetch();
        automodRules = rules.map((rule) => ({
          id: rule.id,
          name: rule.name,
          enabled: rule.enabled,
        }));
      } catch (error) {
        if (!isMissing(error, 50013, 50001)) throw error;
      }

      return {
        id: guild.id,
        name: guild.name,
        ownerId: guild.ownerId,
        features: [...guild.features],
        premiumTier: guild.premiumTier,
        bot: {
          userId: me.id,
          roleIds: [...me.roles.cache.keys()],
          highestRolePosition: me.roles.highest.position,
          permissions: me.permissions.bitfield,
        },
        roles: roles.map((role) => ({
          id: role.id,
          name: role.name,
          color: role.colors.primaryColor,
          hoist: role.hoist,
          mentionable: role.mentionable,
          permissions: role.permissions.bitfield,
          position: role.position,
          managed: role.managed,
        })),
        channels: [...channels.values()]
          .map((channel) => (channel === null ? null : snapshotChannel(channel)))
          .filter((channel): channel is SnapshotChannel => channel !== null),
        emojis: emojis.map((emoji) => ({
          id: emoji.id,
          name: emoji.name,
          animated: emoji.animated,
        })),
        stickers: stickers.map((sticker) => ({ id: sticker.id, name: sticker.name })),
        panelMessages,
        automodRules,
      };
    },

    async createRole(payload) {
      const role = await guild.roles.create({
        name: payload.name,
        colors: { primaryColor: payload.color },
        hoist: payload.hoist,
        mentionable: payload.mentionable,
        permissions: payload.permissions,
        reason: REASON,
      });
      return role.id;
    },

    async editRole(id, payload) {
      await guild.roles.edit(id, {
        ...(payload.name === undefined ? {} : { name: payload.name }),
        ...(payload.color === undefined ? {} : { colors: { primaryColor: payload.color } }),
        ...(payload.hoist === undefined ? {} : { hoist: payload.hoist }),
        ...(payload.mentionable === undefined ? {} : { mentionable: payload.mentionable }),
        ...(payload.permissions === undefined ? {} : { permissions: payload.permissions }),
        reason: REASON,
      });
    },

    async orderRoles(ids) {
      const me = await guild.members.fetchMe();
      const top = me.roles.highest.position;
      const positions = ids
        .map((role, index) => ({ role, position: top - 1 - index }))
        .filter((entry) => entry.position >= 1);
      if (positions.length > 0) await guild.roles.setPositions(positions);
    },

    async deleteRole(id) {
      await guild.roles.delete(id, REASON);
    },

    async createChannel(payload) {
      const channel = await guild.channels.create({
        name: payload.name,
        type: typeOf[payload.kind],
        parent: payload.parentId,
        permissionOverwrites: toOverwrites(payload.overwrites),
        ...(payload.topic === undefined || payload.topic === null ? {} : { topic: payload.topic }),
        ...(payload.userLimit === undefined ? {} : { userLimit: payload.userLimit }),
        ...(payload.slowmodeSeconds === undefined
          ? {}
          : { rateLimitPerUser: payload.slowmodeSeconds }),
        ...(payload.forumTags === undefined
          ? {}
          : {
              availableTags: payload.forumTags.map((tag) => ({
                name: tag.name,
                emoji: { id: null, name: tag.emoji ?? null },
              })),
            }),
        reason: REASON,
      });
      return channel.id;
    },

    async editChannel(id, payload) {
      const channel = await guild.channels.fetch(id);
      if (channel === null || channel.isThread()) throw new Error(`Channel ${id} no longer exists`);
      await channel.edit({
        ...(payload.name === undefined ? {} : { name: payload.name }),
        ...(payload.parentId === undefined
          ? {}
          : { parent: payload.parentId, lockPermissions: false }),
        ...(payload.overwrites === undefined
          ? {}
          : { permissionOverwrites: toOverwrites(payload.overwrites) }),
        ...(payload.topic === undefined || payload.topic === null ? {} : { topic: payload.topic }),
        ...(payload.userLimit === undefined ? {} : { userLimit: payload.userLimit }),
        ...(payload.slowmodeSeconds === undefined
          ? {}
          : { rateLimitPerUser: payload.slowmodeSeconds }),
        reason: REASON,
      });
    },

    async deleteChannel(id) {
      await guild.channels.delete(id, REASON);
    },

    async createEmoji(name, data) {
      const emoji = await guild.emojis.create({ attachment: data, name, reason: REASON });
      return emoji.id;
    },

    async createSticker(name, tags, description, data) {
      const sticker = await guild.stickers.create({
        file: data,
        name,
        tags,
        description,
        reason: REASON,
      });
      return sticker.id;
    },

    async deleteEmoji(id) {
      await guild.emojis.delete(id, REASON);
    },

    async sendMessage(channelId, payload) {
      const channel = await textChannel(guild, channelId);
      const message = await channel.send({
        embeds: payload.embeds,
        components: payload.components,
      });
      return message.id;
    },

    async editMessage(channelId, messageId, payload) {
      try {
        const channel = await textChannel(guild, channelId);
        await channel.messages.edit(messageId, {
          embeds: payload.embeds,
          components: payload.components,
        });
        return true;
      } catch (error) {
        if (isMissing(error, 10003, 10008)) return false;
        throw error;
      }
    },

    async createAutoModRule(payload) {
      const rule = await guild.autoModerationRules.create(automodCreateOptions(payload));
      return rule.id;
    },

    async editAutoModRule(id, payload) {
      const {
        triggerType: _triggerType,
        eventType: _eventType,
        ...options
      } = automodCreateOptions(payload);
      await guild.autoModerationRules.edit(id, { ...options, enabled: payload.enabled });
    },

    async setAutoModEnabled(id, enabled) {
      await guild.autoModerationRules.edit(id, { enabled, reason: REASON });
    },

    async channelHasHumanHistory(id) {
      try {
        const channel = await textChannel(guild, id);
        const messages = await channel.messages.fetch({ limit: 50 });
        return messages.some((message) => !message.author.bot);
      } catch (error) {
        if (error instanceof Error && error.message.includes('cannot hold')) return false; // voice/category
        return null;
      }
    },

    roleMemberCount() {
      // Counting role members needs the privileged Guild Members intent, which
      // Xenon deliberately does not hold. Unknown is treated as "has members".
      return Promise.resolve(null);
    },
  };
}
