import { DiscordAPIError, PermissionFlagsBits, type Guild } from 'discord.js';

import type { GuildRolePort } from '@xenon/discord';

import { logger } from '../runtime';

/**
 * `GuildRolePort` backed by a real guild.
 *
 * The port exists so the reconciliation logic in `@xenon/discord` can be tested
 * without a gateway connection. This is the half that actually talks to
 * Discord, and it is where every Discord-specific failure mode is translated
 * into something the diffing logic can act on.
 */
export function guildRolePort(guild: Guild): GuildRolePort {
  return {
    async memberRoles(discordUserId) {
      try {
        const member = await guild.members.fetch({ user: discordUserId, force: true });
        return [...member.roles.cache.keys()];
      } catch (error) {
        // 10007 is "Unknown Member": they have left the guild. That is a
        // normal state, not an error, and it is reported as "no roles" so the
        // caller can record it rather than retrying forever.
        if (error instanceof DiscordAPIError && error.code === 10007) return null;
        throw error;
      }
    },

    async addRole(discordUserId, roleId) {
      const member = await guild.members.fetch({ user: discordUserId, force: true });
      await member.roles.add(roleId, 'Xenon role synchronisation');
    },

    async removeRole(discordUserId, roleId) {
      const member = await guild.members.fetch({ user: discordUserId, force: true });
      await member.roles.remove(roleId, 'Xenon role synchronisation');
    },

    async canManageRole(roleId) {
      const me = guild.members.me ?? (await guild.members.fetchMe());
      const role = await guild.roles.fetch(roleId);

      if (role === null) {
        logger.warn({ roleId }, 'Mapped Discord role no longer exists');
        return { roleFound: false, hierarchyBlocked: false, manageRolesMissing: false };
      }

      // A role at or above the bot's highest is unmanageable no matter what
      // permissions it has. This is the single most common misconfiguration,
      // and detecting it here turns a stream of 403s into one clear message in
      // the control centre.
      return {
        roleFound: true,
        hierarchyBlocked: me.roles.highest.comparePositionTo(role) <= 0,
        manageRolesMissing: !me.permissions.has(PermissionFlagsBits.ManageRoles),
      };
    },
  };
}
