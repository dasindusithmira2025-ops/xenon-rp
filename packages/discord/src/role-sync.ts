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
  /** False when the bot's highest role sits below the target role. */
  canManageRole(roleId: string): Promise<boolean>;
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
  };

  if (user?.discordAccount == null) {
    return { ...empty, errors: ['No linked Discord account'] };
  }

  const guild = await db.discordGuild.findFirst({ where: { isPrimary: true } });
  if (guild === null) return { ...empty, errors: ['No primary guild configured'] };

  const mappings = await db.discordRoleMapping.findMany({
    where: { guildId: guild.id, syncToDiscord: true },
    select: { id: true, roleId: true, discordRoleId: true },
  });
  if (mappings.length === 0) return { ...empty, applied: true };

  const held = new Set(user.roles.map((assignment) => assignment.roleId));

  // A suspended or banned account is stripped of every mapped role. The Xenon
  // rows survive so the sanction is reversible; the Discord presence does not,
  // because that is what people can see.
  const sanctioned = user.status !== 'ACTIVE';

  const desired = sanctioned
    ? []
    : mappings.filter((mapping) => held.has(mapping.roleId)).map((m) => m.discordRoleId);

  const current = await port.memberRoles(user.discordAccount.discordId);
  if (current === null) {
    return { ...empty, memberMissing: true, errors: ['Member is not in the guild'] };
  }

  const plan = planRoleSync(
    mappings.map((mapping) => mapping.discordRoleId),
    desired,
    current,
  );

  const blocked: string[] = [];
  const errors: string[] = [];

  for (const roleId of [...plan.add, ...plan.remove]) {
    // Hierarchy is checked before attempting, so the common misconfiguration -
    // the bot's role sitting below the roles it manages - is reported as a
    // fixable setup problem rather than as a stream of 403s.
    if (!(await port.canManageRole(roleId))) {
      blocked.push(roleId);
      await db.discordRoleMapping.updateMany({
        where: { guildId: guild.id, discordRoleId: roleId },
        data: { hierarchyBlocked: true, lastError: 'Bot role is below this role' },
      });
    }
  }

  const blockedSet = new Set(blocked);

  for (const roleId of plan.add) {
    if (blockedSet.has(roleId)) continue;
    try {
      await port.addRole(user.discordAccount.discordId, roleId);
    } catch (error) {
      errors.push(`add ${roleId}: ${error instanceof Error ? error.message : 'failed'}`);
    }
  }

  for (const roleId of plan.remove) {
    if (blockedSet.has(roleId)) continue;
    try {
      await port.removeRole(user.discordAccount.discordId, roleId);
    } catch (error) {
      errors.push(`remove ${roleId}: ${error instanceof Error ? error.message : 'failed'}`);
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
    applied: errors.length === 0,
    memberMissing: false,
    errors,
  };
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
    isMember: boolean;
    nickname?: string | null;
    joinedAt?: Date | null;
    roleIds?: readonly string[];
  },
): Promise<void> {
  await db.discordAccount.updateMany({
    where: { discordId },
    data: {
      isGuildMember: membership.isMember,
      guildNickname: membership.nickname ?? null,
      guildJoinedAt: membership.joinedAt ?? null,
      guildRoleIds: membership.roleIds === undefined ? undefined : [...membership.roleIds],
      syncedAt: new Date(),
    },
  });
}
