import type { Db } from '@xenon/database';

/**
 * Discord role reconciliation.
 *
 * Xenon decides who holds which role; Discord is told afterwards. That
 * direction is the whole architecture in one sentence, and it is why this file
 * computes a desired set from the database and then applies a diff, rather than
 * reading Discord and believing it.
 *
 * The guild is reached through a narrow port rather than a `discord.js` Guild,
 * so the diffing logic is unit-testable without a gateway connection and the
 * package does not need a live client to be imported.
 */

export interface GuildRolePort {
  /** Role snowflakes the member currently holds, or null when not in the guild. */
  memberRoles(discordUserId: string): Promise<readonly string[] | null>;
  addRole(discordUserId: string, roleId: string): Promise<void>;
  removeRole(discordUserId: string, roleId: string): Promise<void>;
  /** Explains which local prerequisite prevents a configured role change. */
  canManageRole(roleId: string): Promise<{
    readonly roleFound: boolean;
    readonly hierarchyBlocked: boolean;
    readonly manageRolesMissing: boolean;
  }>;
}

export interface RoleSyncPlan {
  readonly add: readonly string[];
  readonly remove: readonly string[];
  readonly blocked: readonly string[];
  readonly unchanged: number;
}

export interface RoleSyncOutcome extends RoleSyncPlan {
  readonly applied: boolean;
  readonly memberMissing: boolean;
  readonly errors: readonly string[];
  readonly permanentErrors: readonly string[];
}

/**
 * Work out what to change.
 *
 * Only mapped roles are considered on either side. Community roles that Xenon
 * knows nothing about - colours, pingable groups, event roles - must survive
 * synchronisation untouched, which is why `remove` is computed against the
 * mapped set rather than against everything the member holds.
 */
export function planRoleSync(
  managedRoleIds: readonly string[],
  desiredRoleIds: readonly string[],
  currentRoleIds: readonly string[],
): RoleSyncPlan {
  const managed = new Set(managedRoleIds);
  const desired = new Set(desiredRoleIds);
  const current = new Set(currentRoleIds);

  const add = [...desired].filter((roleId) => !current.has(roleId));
  const remove = [...current].filter((roleId) => managed.has(roleId) && !desired.has(roleId));
  const unchanged = [...desired].filter((roleId) => current.has(roleId)).length;

  return { add, remove, blocked: [], unchanged };
}

/**
 * Reconcile one user's Discord roles.
 *
 * Idempotent: running it twice makes the same API calls the second time only if
 * the first did not take effect. Safe to retry, which is what the job queue
 * does on a rate limit.
 */
export async function syncUserRoles(
  db: Db,
  port: GuildRolePort,
  userId: string,
): Promise<RoleSyncOutcome> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      status: true,
      whitelistState: true,
      discordAccount: { select: { discordId: true } },
      roles: {
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        select: { roleId: true },
      },
    },
  });

  const empty: RoleSyncOutcome = {
    add: [],
    remove: [],
    blocked: [],
    unchanged: 0,
    applied: false,
    memberMissing: false,
    errors: [],
    permanentErrors: [],
  };

  if (user === null) {
    return { ...empty, permanentErrors: ['Xenon user no longer exists'] };
  }

  if (user.discordAccount === null) {
    return { ...empty, errors: ['No linked Discord account'] };
  }

  const guild = await db.discordGuild.findFirst({ where: { isPrimary: true } });
  if (guild === null) return { ...empty, errors: ['No primary guild configured'] };

  const [mappings, whitelistedRole] = await Promise.all([
    db.discordRoleMapping.findMany({
      where: { guildId: guild.id, syncToDiscord: true },
      select: { id: true, roleId: true, discordRoleId: true },
    }),
    // The provisioned Whitelisted role mirrors a state rather than a Xenon
    // role, so it is resolved from the managed resource registry.
    db.discordManagedResource.findUnique({
      where: { guildId_logicalKey: { guildId: guild.guildId, logicalKey: 'role.whitelisted' } },
      select: { discordResourceId: true, managed: true },
    }),
  ]);
  const whitelistedRoleId =
    whitelistedRole?.managed === true ? whitelistedRole.discordResourceId : null;
  if (mappings.length === 0 && whitelistedRoleId === null) return { ...empty, applied: true };

  const held = new Set(user.roles.map((assignment) => assignment.roleId));

  // A suspended or banned account is stripped of every mapped role. The Xenon
  // rows survive so the sanction is reversible; the Discord presence does not,
  // because that is what people can see.
  const sanctioned = user.status !== 'ACTIVE';

  const desired = sanctioned
    ? []
    : [
        ...mappings.filter((mapping) => held.has(mapping.roleId)).map((m) => m.discordRoleId),
        ...(whitelistedRoleId !== null && user.whitelistState === 'APPROVED'
          ? [whitelistedRoleId]
          : []),
      ];

  const current = await port.memberRoles(user.discordAccount.discordId);
  if (current === null) {
    return { ...empty, memberMissing: true, errors: ['Member is not in the guild'] };
  }

  const plan = planRoleSync(
    [
      ...mappings.map((mapping) => mapping.discordRoleId),
      ...(whitelistedRoleId === null ? [] : [whitelistedRoleId]),
    ],
    desired,
    current,
  );

  const blocked: string[] = [];
  const errors: string[] = [];
  const permanentErrors: string[] = [];
  const permanentlyBlockedRoleIds: string[] = [];

  for (const roleId of [...plan.add, ...plan.remove]) {
    // Hierarchy is checked before attempting, so the common misconfiguration -
    // the bot's role sitting below the roles it manages - is reported as a
    // fixable setup problem rather than as a stream of 403s.
    const prerequisite = await port.canManageRole(roleId);
    if (!prerequisite.roleFound) {
      permanentlyBlockedRoleIds.push(roleId);
      permanentErrors.push(`role ${roleId} no longer exists in the configured guild`);
      await db.discordRoleMapping.updateMany({
        where: { guildId: guild.id, discordRoleId: roleId },
        data: { hierarchyBlocked: false, lastError: 'Discord role no longer exists' },
      });
      continue;
    }
    if (prerequisite.manageRolesMissing) {
      permanentlyBlockedRoleIds.push(roleId);
      permanentErrors.push('bot is missing MANAGE_ROLES in the configured guild');
      await db.discordRoleMapping.updateMany({
        where: { guildId: guild.id, discordRoleId: roleId },
        data: { hierarchyBlocked: false, lastError: 'Bot is missing Manage Roles permission' },
      });
      continue;
    }
    if (prerequisite.hierarchyBlocked) {
      blocked.push(roleId);
      await db.discordRoleMapping.updateMany({
        where: { guildId: guild.id, discordRoleId: roleId },
        data: { hierarchyBlocked: true, lastError: 'Bot role is below this role' },
      });
    }
  }

  const blockedSet = new Set([...blocked, ...permanentlyBlockedRoleIds]);

  for (const roleId of plan.add) {
    if (blockedSet.has(roleId)) continue;
    try {
      await port.addRole(user.discordAccount.discordId, roleId);
    } catch (error) {
      const code = discordErrorCode(error);
      if (code === 50013 || code === 10011 || code === 10007) {
        if (code !== 10007) {
          await db.discordRoleMapping.updateMany({
            where: { guildId: guild.id, discordRoleId: roleId },
            data: {
              hierarchyBlocked: false,
              lastError:
                code === 50013
                  ? 'Bot is missing Manage Roles permission'
                  : 'Discord role no longer exists',
            },
          });
        }
        permanentErrors.push(
          code === 50013
            ? `missing permission to add role ${roleId}`
            : code === 10011
              ? `role ${roleId} no longer exists`
              : 'member left the configured guild during role sync',
        );
      } else {
        errors.push(`add role ${roleId} failed`);
      }
    }
  }

  for (const roleId of plan.remove) {
    if (blockedSet.has(roleId)) continue;
    try {
      await port.removeRole(user.discordAccount.discordId, roleId);
    } catch (error) {
      const code = discordErrorCode(error);
      if (code === 50013 || code === 10011 || code === 10007) {
        if (code !== 10007) {
          await db.discordRoleMapping.updateMany({
            where: { guildId: guild.id, discordRoleId: roleId },
            data: {
              hierarchyBlocked: false,
              lastError:
                code === 50013
                  ? 'Bot is missing Manage Roles permission'
                  : 'Discord role no longer exists',
            },
          });
        }
        permanentErrors.push(
          code === 50013
            ? `missing permission to remove role ${roleId}`
            : code === 10011
              ? `role ${roleId} no longer exists`
              : 'member left the configured guild during role sync',
        );
      } else {
        errors.push(`remove role ${roleId} failed`);
      }
    }
  }

  const changed = [...plan.add, ...plan.remove].filter((roleId) => !blockedSet.has(roleId));
  if (changed.length > 0 && errors.length === 0) {
    await db.discordRoleMapping.updateMany({
      where: { guildId: guild.id, discordRoleId: { in: changed } },
      data: { lastSyncedAt: new Date(), hierarchyBlocked: false, lastError: null },
    });
  }

  return {
    ...plan,
    blocked,
    applied: errors.length === 0 && permanentErrors.length === 0 && blocked.length === 0,
    memberMissing: false,
    errors,
    permanentErrors,
  };
}

function discordErrorCode(error: unknown): number | null {
  if (error === null || typeof error !== 'object' || !('code' in error)) return null;
  const { code } = error;
  return typeof code === 'number' ? code : null;
}

/** Record the outcome of a Discord profile sync on the account row. */
export async function recordDiscordSync(
  db: Db,
  userId: string,
  outcome: { ok: boolean; error?: string },
): Promise<void> {
  await db.discordAccount.updateMany({
    where: { userId },
    data: outcome.ok
      ? { syncedAt: new Date(), syncFailedAt: null, syncError: null }
      : { syncFailedAt: new Date(), syncError: (outcome.error ?? 'Unknown').slice(0, 500) },
  });
}

/** Update the cached guild-membership projection after a member event. */
export async function updateGuildMembership(
  db: Db,
  discordId: string,
  membership: {
    isMember?: boolean;
    pendingScreening?: boolean;
    state?:
      'UNKNOWN' | 'MEMBER' | 'PENDING_SCREENING' | 'NOT_MEMBER' | 'UNAVAILABLE' | 'MISCONFIGURED';
    nickname?: string | null;
    joinedAt?: Date | null;
    roleIds?: readonly string[];
    error?: string | null;
  },
): Promise<void> {
  const state =
    membership.state ??
    (membership.isMember === false
      ? 'NOT_MEMBER'
      : membership.pendingScreening === true
        ? 'PENDING_SCREENING'
        : membership.isMember === true
          ? 'MEMBER'
          : 'UNKNOWN');
  // Membership-gated actions require screening to be complete.
  const isMember = state === 'MEMBER';

  await db.discordAccount.updateMany({
    where: { discordId },
    data: {
      isGuildMember: isMember,
      guildMembershipState: state,
      ...(membership.nickname === undefined ? {} : { guildNickname: membership.nickname }),
      ...(membership.joinedAt === undefined ? {} : { guildJoinedAt: membership.joinedAt }),
      guildRoleIds: membership.roleIds === undefined ? undefined : [...membership.roleIds],
      guildSyncedAt: new Date(),
      guildSyncError: membership.error?.slice(0, 500) ?? null,
    },
  });
}
