import { ConflictError, isPermissionKey, NotFoundError, type PermissionKey } from '@xenon/core';
import type { Db } from '@xenon/database';
import { enqueueBestEffort } from '@xenon/jobs';
import { type Actor, requirePermission } from '@xenon/permissions';

import { recordAudit } from './audit';

/**
 * Role assignment.
 *
 * Xenon owns role membership; Discord mirrors it. Every grant and revocation
 * therefore writes to Postgres first and schedules a Discord reconciliation
 * afterwards, so a guild outage delays the coloured name rather than the
 * permission.
 */

/**
 * Nobody may hand out authority they do not hold.
 *
 * Two guards, both necessary. The priority check stops a moderator promoting
 * someone to administrator; the capability check stops them granting a single
 * capability they lack via a lower-priority role that happens to contain it.
 */
async function assertCanManageRole(db: Db, actor: Actor, roleId: string) {
  requirePermission(actor, 'staff.manage');

  const role = await db.role.findUnique({
    where: { id: roleId },
    include: { permissions: { include: { permission: true } } },
  });
  if (role === null) throw new NotFoundError('Role', roleId);

  const actorPriority = await highestPriority(db, actor);
  if (role.priority >= actorPriority) {
    throw new ConflictError(
      `Actor priority ${String(actorPriority)} cannot manage role priority ${String(role.priority)}`,
      'You cannot manage a role at or above your own rank.',
    );
  }

  for (const grant of role.permissions) {
    const key = grant.permission.key;
    if (isPermissionKey(key) && !actor.permissions.has(key)) {
      throw new ConflictError(
        `Actor lacks ${key}, which this role grants`,
        'That role grants a permission you do not hold yourself.',
      );
    }
  }

  return role;
}

/** The highest role priority an actor holds. Owner is effectively unbounded. */
async function highestPriority(db: Db, actor: Actor): Promise<number> {
  if (actor.userId === null) return Number.MAX_SAFE_INTEGER;
  if (actor.roleKeys.has('owner')) return Number.MAX_SAFE_INTEGER;

  const rows = await db.userRole.findMany({
    where: { userId: actor.userId },
    select: { role: { select: { priority: true } } },
  });

  return rows.reduce((max, row) => Math.max(max, row.role.priority), 0);
}

export interface AssignRoleInput {
  readonly userId: string;
  readonly roleId: string;
  readonly expiresAt?: Date | null;
  readonly reason?: string;
}

/** Grant a role and queue the Discord mirror. */
export async function assignRole(db: Db, actor: Actor, input: AssignRoleInput): Promise<void> {
  const role = await assertCanManageRole(db, actor, input.roleId);

  const user = await db.user.findUnique({
    where: { id: input.userId },
    select: { publicId: true },
  });
  if (user === null) throw new NotFoundError('User', input.userId);

  await db.userRole.upsert({
    where: { userId_roleId: { userId: input.userId, roleId: input.roleId } },
    create: {
      userId: input.userId,
      roleId: input.roleId,
      assignedBy: actor.userId,
      expiresAt: input.expiresAt ?? null,
    },
    update: { expiresAt: input.expiresAt ?? null, assignedBy: actor.userId },
  });

  await recordAudit(db, actor, {
    action: 'role.assigned',
    entityType: 'user',
    entityId: input.userId,
    entityLabel: user.publicId,
    after: { roleKey: role.key, expiresAt: input.expiresAt?.toISOString() ?? null },
    metadata: input.reason === undefined ? undefined : { reason: input.reason },
  });

  await enqueueBestEffort('discord.role.sync', {
    userId: input.userId,
    reason: `role.assigned:${role.key}`,
  });
}

/** Revoke a role and queue the Discord mirror. */
export async function removeRole(
  db: Db,
  actor: Actor,
  userId: string,
  roleId: string,
  reason?: string,
): Promise<void> {
  const role = await assertCanManageRole(db, actor, roleId);

  if (role.key === 'member') {
    throw new ConflictError(
      'The member role cannot be removed',
      'Every account holds the member role.',
    );
  }

  const user = await db.user.findUnique({ where: { id: userId }, select: { publicId: true } });
  if (user === null) throw new NotFoundError('User', userId);

  await db.userRole.deleteMany({ where: { userId, roleId } });

  await recordAudit(db, actor, {
    action: 'role.removed',
    entityType: 'user',
    entityId: userId,
    entityLabel: user.publicId,
    before: { roleKey: role.key },
    metadata: reason === undefined ? undefined : { reason },
  });

  await enqueueBestEffort('discord.role.sync', { userId, reason: `role.removed:${role.key}` });
}

/**
 * Grant roles by key, as part of an automated flow such as an approval.
 *
 * Takes no actor capability check because the calling service has already
 * authorised the decision that confers them; a template that grants a role is
 * itself editable only by `applications.manage_templates`.
 */
export async function grantRoleKeys(
  db: Db,
  userId: string,
  roleKeys: readonly string[],
): Promise<readonly string[]> {
  if (roleKeys.length === 0) return [];

  const roles = await db.role.findMany({
    where: { key: { in: [...roleKeys] } },
    select: { id: true, key: true },
  });

  for (const role of roles) {
    await db.userRole.upsert({
      where: { userId_roleId: { userId, roleId: role.id } },
      create: { userId, roleId: role.id },
      update: {},
    });
  }

  return roles.map((role) => role.key);
}

/** Every role, with its capability grants. Drives the permission matrix. */
export async function listRoles(db: Db) {
  return db.role.findMany({
    orderBy: { priority: 'desc' },
    include: {
      permissions: { include: { permission: true } },
      _count: { select: { users: true } },
    },
  });
}

/**
 * Replace a role's capability set.
 *
 * An actor cannot grant a capability they do not themselves hold, which is what
 * stops privilege escalation by editing a role rather than by assigning one.
 */
export async function setRolePermissions(
  db: Db,
  actor: Actor,
  roleId: string,
  permissionKeys: readonly string[],
): Promise<void> {
  const role = await assertCanManageRole(db, actor, roleId);

  const wanted = permissionKeys.filter(isPermissionKey);
  const escalation = wanted.filter((key: PermissionKey) => !actor.permissions.has(key));
  if (escalation.length > 0 && !actor.roleKeys.has('owner')) {
    throw new ConflictError(
      `Actor cannot grant ${escalation.join(', ')}`,
      'You can only grant permissions you hold yourself.',
    );
  }

  const permissions = await db.permission.findMany({
    where: { key: { in: wanted } },
    select: { id: true },
  });

  const before = role.permissions.map((grant) => grant.permission.key);

  await db.rolePermission.deleteMany({ where: { roleId } });
  await db.rolePermission.createMany({
    data: permissions.map((permission) => ({ roleId, permissionId: permission.id })),
    skipDuplicates: true,
  });

  await recordAudit(db, actor, {
    action: 'role.permissions_changed',
    entityType: 'role',
    entityId: roleId,
    entityLabel: role.key,
    before: { permissions: before },
    after: { permissions: wanted },
  });
}

/** Expire role assignments whose window has passed. Run by the sweep job. */
export async function expireRoleAssignments(db: Db): Promise<number> {
  const expired = await db.userRole.findMany({
    where: { expiresAt: { not: null, lte: new Date() } },
    select: { userId: true, roleId: true },
  });

  if (expired.length === 0) return 0;

  await db.userRole.deleteMany({
    where: { OR: expired.map(({ userId, roleId }) => ({ userId, roleId })) },
  });

  for (const userId of new Set(expired.map((row) => row.userId))) {
    await enqueueBestEffort('discord.role.sync', { userId, reason: 'role.expired' });
  }

  return expired.length;
}
