import type { Db } from '@xenon/database';

import { updateGuildMembership } from './role-sync';

export interface GuildMemberSnapshot {
  readonly nickname: string | null;
  readonly joinedAt: Date | null;
  readonly roleIds: readonly string[];
  readonly pendingScreening: boolean;
}

/** Narrow REST boundary so membership policy is testable without Discord. */
export interface GuildMembershipPort {
  /** Null means Discord confirmed the snowflake is not in this guild. */
  member(discordUserId: string): Promise<GuildMemberSnapshot | null>;
}

export type GuildMembershipState =
  'MEMBER' | 'PENDING_SCREENING' | 'NOT_MEMBER' | 'UNAVAILABLE' | 'MISCONFIGURED';

/**
 * Refresh the persisted membership snapshot using a single-member REST lookup.
 * Network/configuration failure stays distinct from a confirmed non-member.
 */
export async function syncGuildMembership(
  db: Db,
  port: GuildMembershipPort,
  discordUserId: string,
): Promise<GuildMembershipState> {
  try {
    const snapshot = await port.member(discordUserId);
    if (snapshot === null) {
      await updateGuildMembership(db, discordUserId, {
        state: 'NOT_MEMBER',
        nickname: null,
        joinedAt: null,
        roleIds: [],
      });
      return 'NOT_MEMBER';
    }

    const state = snapshot.pendingScreening ? 'PENDING_SCREENING' : 'MEMBER';
    await updateGuildMembership(db, discordUserId, {
      state,
      nickname: snapshot.nickname,
      joinedAt: snapshot.joinedAt,
      roleIds: snapshot.roleIds,
    });
    return state;
  } catch (error) {
    await updateGuildMembership(db, discordUserId, {
      state: 'UNAVAILABLE',
      error: 'Discord could not confirm this membership right now',
    });
    throw error;
  }
}
