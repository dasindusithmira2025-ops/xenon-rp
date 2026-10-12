import type { GuildMembershipPort, GuildRolePort } from '@xenon/discord';

import { DiscordRequestError, type GatewayCall, GatewayError } from './gateway-client';

/**
 * `GuildRolePort` and `GuildMembershipPort` over Xenon Link's gateway.
 *
 * The reconciliation logic in `@xenon/discord` is unchanged: it asks the same
 * questions it asked the in-process bot. Link answers them, and enforces its
 * own limits besides - it refuses any role carrying a privileged permission,
 * which `role.inspect` reports as `privileged` so the mapping records a clear
 * operator-facing reason instead of failing every sync.
 */

const ROLE_SYNC_REASON = 'Xenon role synchronisation';

/**
 * Link refusing a role target is permanent until an operator remaps the role.
 * Reported to the role diff as Discord's "missing permission" (50013), which
 * it already treats as permanent and records on the mapping.
 */
async function changeRole(
  gateway: GatewayCall,
  discordUserId: string,
  roleId: string,
  action: 'add' | 'remove',
): Promise<void> {
  try {
    await gateway('member.role', { discordUserId, roleId, action, reason: ROLE_SYNC_REASON });
  } catch (error) {
    if (error instanceof GatewayError && error.gatewayCode === 'FORBIDDEN_TARGET') {
      throw new DiscordRequestError(50013, error.message, false);
    }
    throw error;
  }
}

export function gatewayRolePort(gateway: GatewayCall): GuildRolePort {
  return {
    async memberRoles(discordUserId) {
      const { roleIds } = await gateway('member.roles', { discordUserId });
      return roleIds;
    },
    addRole: (discordUserId, roleId) => changeRole(gateway, discordUserId, roleId, 'add'),
    removeRole: (discordUserId, roleId) => changeRole(gateway, discordUserId, roleId, 'remove'),
    canManageRole: (roleId) => gateway('role.inspect', { roleId }),
  };
}

/** One-user lookup. Link answers `member: null` when Discord confirms absence. */
export function gatewayMembershipPort(gateway: GatewayCall): GuildMembershipPort {
  return {
    async member(discordUserId) {
      const { member } = await gateway('member.snapshot', { discordUserId });
      if (member === null) return null;
      return {
        nickname: member.nickname,
        joinedAt: member.joinedAt === null ? null : new Date(member.joinedAt),
        roleIds: member.roleIds,
        pendingScreening: member.pendingScreening,
      };
    },
  };
}
