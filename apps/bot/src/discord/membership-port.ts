import { DiscordAPIError, type Guild } from 'discord.js';

import type { GuildMembershipPort } from '@xenon/discord';

/** One-user REST lookup. It does not enable the privileged Gateway Members intent. */
export function guildMembershipPort(guild: Guild): GuildMembershipPort {
  return {
    async member(discordUserId) {
      try {
        const member = await guild.members.fetch({ user: discordUserId, force: true });
        return {
          nickname: member.nickname,
          joinedAt: member.joinedAt,
          roleIds: [...member.roles.cache.keys()],
          pendingScreening: member.pending,
        };
      } catch (error) {
        // Discord confirms absence with Unknown Member. Every other error is an
        // outage or configuration failure and stays distinguishable upstream.
        if (error instanceof DiscordAPIError && error.code === 10007) return null;
        throw error;
      }
    },
  };
}
