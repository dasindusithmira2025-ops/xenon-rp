import { PermissionFlagsBits as P, PermissionsBitField, type Guild } from 'discord.js';

import { createIncident, type GuildSecuritySnapshot, type OverwriteSnapshot } from './model';

import type { DiscordRuntimeStore } from '../runtime-store';
import type { SecurityService } from './service';

export const DANGEROUS_BITS: readonly bigint[] = [
  P.Administrator,
  P.ManageRoles,
  P.ManageChannels,
  P.ManageGuild,
  P.BanMembers,
  P.KickMembers,
  P.ManageWebhooks,
  P.MentionEveryone,
];

export const RESTORE_LIMITATION =
  'Discord IDs and message history cannot be restored; deleted roles and channels must be recreated manually and will receive new IDs.';

export interface RoleFact {
  readonly id: string;
  readonly name: string;
  readonly permissions: string;
  readonly position: number;
  readonly managed: boolean;
}

export interface ChannelFact {
  readonly id: string;
  readonly name: string;
  readonly type: number;
  readonly parentId: string | null;
  readonly overwrites: readonly OverwriteSnapshot[];
}

export interface CurrentGuildFacts {
  readonly roles: readonly RoleFact[];
  readonly channels: readonly ChannelFact[];
}

export interface PermissionDelta {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export interface DeletedRole {
  readonly id: string;
  readonly name: string;
  readonly permissions: readonly string[];
}

export interface DeletedChannel {
  readonly id: string;
  readonly name: string;
  readonly type: number;
  readonly parentId: string | null;
  readonly overwrites: readonly OverwriteSnapshot[];
}

export interface ChangedRole extends PermissionDelta {
  readonly id: string;
  readonly name: string;
}

export interface ChangedChannel {
  readonly id: string;
  readonly name: string;
  readonly addedOverwrites: readonly string[];
  readonly removedOverwrites: readonly string[];
  readonly changedOverwrites: readonly string[];
}

export interface NewDangerousRole {
  readonly id: string;
  readonly name: string;
  readonly managed: boolean;
  readonly permissions: readonly string[];
}

export interface SnapshotComparison {
  readonly deletedRoles: readonly DeletedRole[];
  readonly deletedChannels: readonly DeletedChannel[];
  readonly changedRoles: readonly ChangedRole[];
  readonly changedChannels: readonly ChangedChannel[];
  readonly newDangerousRoles: readonly NewDangerousRole[];
}

export interface BotRestoreFacts {
  readonly highestPosition: number;
  readonly permissions: bigint;
}

export interface RestoreChange extends PermissionDelta {
  readonly roleId: string;
  readonly name: string;
  readonly target: bigint;
}

export interface RestoreSkip {
  readonly roleId: string;
  readonly name: string;
  readonly reason: string;
}

export interface RestorePlan {
  readonly changes: readonly RestoreChange[];
  readonly skipped: readonly RestoreSkip[];
}

function names(bits: bigint): string[] {
  return new PermissionsBitField(bits).toArray();
}

function isDangerous(bits: bigint): boolean {
  return DANGEROUS_BITS.some((flag) => (bits & flag) !== 0n);
}

function describeOverwrite(overwrite: OverwriteSnapshot): string {
  const allow = names(BigInt(overwrite.allow));
  const deny = names(BigInt(overwrite.deny));
  return `${overwrite.type === 0 ? 'role' : 'member'} ${overwrite.id} allow[${allow.join(', ') || '-'}] deny[${deny.join(', ') || '-'}]`;
}

/** Build plain facts from the live guild cache; the only Discord-coupled step of comparison. */
export function collectGuildFacts(guild: Guild): CurrentGuildFacts {
  return {
    roles: [...guild.roles.cache.values()].map((role) => ({
      id: role.id,
      name: role.name,
      permissions: role.permissions.bitfield.toString(),
      position: role.position,
      managed: role.managed,
    })),
    channels: [...guild.channels.cache.values()]
      .filter((channel) => 'permissionOverwrites' in channel)
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        type: channel.type,
        parentId: channel.parentId,
        overwrites: [...channel.permissionOverwrites.cache.values()].map((overwrite) => ({
          id: overwrite.id,
          type: overwrite.type,
          allow: overwrite.allow.bitfield.toString(),
          deny: overwrite.deny.bitfield.toString(),
        })),
      })),
  };
}

export function compareSnapshot(
  snapshot: GuildSecuritySnapshot,
  current: CurrentGuildFacts,
): SnapshotComparison {
  const currentRoles = new Map(current.roles.map((role) => [role.id, role]));
  const currentChannels = new Map(current.channels.map((channel) => [channel.id, channel]));
  const snapshotRoleIds = new Set(snapshot.roles.map((role) => role.id));

  const deletedRoles: DeletedRole[] = [];
  const changedRoles: ChangedRole[] = [];
  for (const role of snapshot.roles) {
    const live = currentRoles.get(role.id);
    const before = BigInt(role.permissions);
    if (live === undefined) {
      deletedRoles.push({ id: role.id, name: role.name, permissions: names(before) });
      continue;
    }
    const after = BigInt(live.permissions);
    if (before === after) continue;
    changedRoles.push({
      id: role.id,
      name: live.name,
      added: names(after & ~before),
      removed: names(before & ~after),
    });
  }

  const deletedChannels: DeletedChannel[] = [];
  const changedChannels: ChangedChannel[] = [];
  for (const channel of snapshot.channels) {
    const live = currentChannels.get(channel.id);
    if (live === undefined) {
      deletedChannels.push({
        id: channel.id,
        name: channel.name,
        type: channel.type,
        parentId: channel.parentId,
        overwrites: channel.overwrites,
      });
      continue;
    }
    const before = new Map(channel.overwrites.map((overwrite) => [overwrite.id, overwrite]));
    const after = new Map(live.overwrites.map((overwrite) => [overwrite.id, overwrite]));
    const addedOverwrites = [...after.values()]
      .filter((overwrite) => !before.has(overwrite.id))
      .map(describeOverwrite);
    const removedOverwrites = [...before.values()]
      .filter((overwrite) => !after.has(overwrite.id))
      .map(describeOverwrite);
    const changedOverwrites = [...after.values()]
      .filter((overwrite) => {
        const previous = before.get(overwrite.id);
        return (
          previous !== undefined &&
          (previous.allow !== overwrite.allow ||
            previous.deny !== overwrite.deny ||
            previous.type !== overwrite.type)
        );
      })
      .map(describeOverwrite);
    if (addedOverwrites.length + removedOverwrites.length + changedOverwrites.length > 0)
      changedChannels.push({
        id: channel.id,
        name: live.name,
        addedOverwrites,
        removedOverwrites,
        changedOverwrites,
      });
  }

  const newDangerousRoles: NewDangerousRole[] = [];
  for (const role of current.roles) {
    if (snapshotRoleIds.has(role.id)) continue;
    const bits = BigInt(role.permissions);
    if (!isDangerous(bits)) continue;
    newDangerousRoles.push({
      id: role.id,
      name: role.name,
      managed: role.managed,
      permissions: names(bits),
    });
  }
  return { deletedRoles, deletedChannels, changedRoles, changedChannels, newDangerousRoles };
}

export function formatComparison(comparison: SnapshotComparison, createdAt: string): string {
  const lines: string[] = [`Snapshot ${createdAt} compared with the live server.`];
  const total =
    comparison.deletedRoles.length +
    comparison.deletedChannels.length +
    comparison.changedRoles.length +
    comparison.changedChannels.length +
    comparison.newDangerousRoles.length;
  if (total === 0) {
    lines.push('No differences found in roles, role permissions, or channel overwrites.');
    return lines.join('\n');
  }
  const section = <T>(title: string, items: readonly T[], render: (item: T) => string) => {
    if (items.length === 0) return;
    lines.push(`**${title} (${String(items.length)})**`);
    for (const item of items.slice(0, 8)) lines.push(`• ${render(item)}`);
    if (items.length > 8) lines.push(`• …and ${String(items.length - 8)} more`);
  };
  section(
    'Deleted roles',
    comparison.deletedRoles,
    (role) => `${role.name} (${role.id}) permissions: ${role.permissions.join(', ') || 'none'}`,
  );
  section(
    'Deleted channels',
    comparison.deletedChannels,
    (channel) =>
      `${channel.name} (${channel.id}, type ${String(channel.type)}) overwrites: ${channel.overwrites.map(describeOverwrite).join('; ') || 'none'}`,
  );
  if (comparison.deletedRoles.length + comparison.deletedChannels.length > 0)
    lines.push(`_${RESTORE_LIMITATION}_`);
  section(
    'Role permission changes',
    comparison.changedRoles,
    (role) =>
      `${role.name} (${role.id}) +[${role.added.join(', ') || '-'}] −[${role.removed.join(', ') || '-'}]`,
  );
  section(
    'Channel overwrite changes',
    comparison.changedChannels,
    (channel) =>
      `${channel.name} (${channel.id}) added[${channel.addedOverwrites.join('; ') || '-'}] removed[${channel.removedOverwrites.join('; ') || '-'}] changed[${channel.changedOverwrites.join('; ') || '-'}]`,
  );
  section(
    'New roles with dangerous permissions',
    comparison.newDangerousRoles,
    (role) =>
      `${role.name} (${role.id})${role.managed ? ' [managed]' : ''}: ${role.permissions.join(', ')}`,
  );
  return lines.join('\n');
}

/**
 * Deterministic planner: only permission bitfields of surviving roles are ever restored.
 * A role is skipped (never partially restored) when Discord would reject or the bot lacks authority.
 */
export function planRestore(
  snapshot: GuildSecuritySnapshot,
  current: CurrentGuildFacts,
  bot: BotRestoreFacts,
): RestorePlan {
  const currentRoles = new Map(current.roles.map((role) => [role.id, role]));
  const botIsAdmin = (bot.permissions & P.Administrator) !== 0n;
  const botCanManageRoles = botIsAdmin || (bot.permissions & P.ManageRoles) !== 0n;
  const changes: RestoreChange[] = [];
  const skipped: RestoreSkip[] = [];
  for (const role of snapshot.roles) {
    const live = currentRoles.get(role.id);
    if (live === undefined) continue;
    const target = BigInt(role.permissions);
    const existing = BigInt(live.permissions);
    if (target === existing) continue;
    const skip = (reason: string) => skipped.push({ roleId: role.id, name: live.name, reason });
    if (live.managed) skip('managed role (integration/bot role) cannot be edited');
    else if (!botCanManageRoles) skip('bot lacks Manage Roles');
    else if (live.position >= bot.highestPosition)
      skip('role is at or above the bot’s highest role');
    else {
      const grants = target & ~existing;
      const ungrantable = botIsAdmin ? 0n : grants & ~bot.permissions;
      if (ungrantable !== 0n)
        skip(`would grant permissions the bot lacks: ${names(ungrantable).join(', ')}`);
      else
        changes.push({
          roleId: role.id,
          name: live.name,
          target,
          added: names(grants),
          removed: names(existing & ~target),
        });
    }
  }
  return { changes, skipped };
}

export interface RestoreResult {
  readonly applied: readonly string[];
  readonly failed: readonly {
    readonly roleId: string;
    readonly name: string;
    readonly error: string;
  }[];
}

export function describeDiscordError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error)
    return `Discord error ${String(error.code)}`;
  return 'request failed';
}

export async function applyRestore(
  guild: Guild,
  plan: RestorePlan,
  reason: string,
): Promise<RestoreResult> {
  const applied: string[] = [];
  const failed: { roleId: string; name: string; error: string }[] = [];
  for (const change of plan.changes) {
    const role = guild.roles.cache.get(change.roleId);
    if (role === undefined) {
      failed.push({ roleId: change.roleId, name: change.name, error: 'role no longer exists' });
      continue;
    }
    try {
      await role.setPermissions(change.target, reason);
      applied.push(change.roleId);
    } catch (error) {
      failed.push({ roleId: change.roleId, name: change.name, error: describeDiscordError(error) });
    }
  }
  return { applied, failed };
}

function formatPlan(plan: RestorePlan): string[] {
  const lines: string[] = [];
  for (const change of plan.changes.slice(0, 10))
    lines.push(
      `• ${change.name} (${change.roleId}) +[${change.added.join(', ') || '-'}] −[${change.removed.join(', ') || '-'}]`,
    );
  if (plan.changes.length > 10) lines.push(`• …and ${String(plan.changes.length - 10)} more`);
  return lines;
}

function formatSkips(plan: RestorePlan): string[] {
  if (plan.skipped.length === 0) return [];
  const lines = [`Skipped (${String(plan.skipped.length)}):`];
  for (const skip of plan.skipped.slice(0, 8))
    lines.push(`• ${skip.name} (${skip.roleId}): ${skip.reason}`);
  if (plan.skipped.length > 8) lines.push(`• …and ${String(plan.skipped.length - 8)} more`);
  return lines;
}

/** Dry-run by default; with confirm, snapshots first, applies per role, and persists an incident. */
export async function restoreRolePermissions(
  guild: Guild,
  store: DiscordRuntimeStore,
  service: SecurityService,
  actorId: string,
  snapshot: GuildSecuritySnapshot,
  confirm: boolean,
): Promise<string> {
  const me = guild.members.me;
  const plan = planRestore(snapshot, collectGuildFacts(guild), {
    highestPosition: me?.roles.highest.position ?? -1,
    permissions: me?.permissions.bitfield ?? 0n,
  });
  const header = `Role-permission restore from snapshot ${snapshot.createdAt}. Roles and channels are never created or deleted.`;
  if (plan.changes.length === 0)
    return [header, 'Nothing eligible to restore.', ...formatSkips(plan)].join('\n');
  if (!confirm)
    return [
      header,
      `DRY RUN — ${String(plan.changes.length)} role(s) would change. Re-run with confirm:true to apply.`,
      ...formatPlan(plan),
      ...formatSkips(plan),
    ].join('\n');

  let snapshotNote = 'Pre-restore snapshot saved.';
  try {
    await service.saveSnapshot(guild);
  } catch {
    return `${header}\nAborted: could not take a pre-restore snapshot, so nothing was changed.`;
  }
  const result = await applyRestore(
    guild,
    plan,
    `Xenon snapshot permission restore by ${actorId} from ${snapshot.createdAt}`,
  );
  const incident = createIncident({
    severity: 'MEDIUM',
    title: 'Role permissions restored from snapshot',
    source: 'SecuritySnapshotService',
    rule: 'SNAPSHOT_PERMISSION_RESTORE',
    actorId,
    targetId: null,
    evidence: [
      `Snapshot ${snapshot.createdAt}`,
      ...plan.changes.map(
        (change) =>
          `${change.name} (${change.roleId}) +[${change.added.join(', ')}] −[${change.removed.join(', ')}]`,
      ),
    ].slice(0, 25),
    automatic: false,
    actionTaken: [
      `Restored ${String(result.applied.length)} role permission set(s)`,
      ...result.failed.map((failure) => `FAILED ${failure.roleId}: ${failure.error}`),
    ].slice(0, 25),
    auditCorrelation: 'NOT_APPLICABLE',
  });
  try {
    await store.updateGuild(guild.id, (current) => ({
      ...current,
      security: {
        ...current.security,
        incidents: [...current.security.incidents, incident].slice(-500),
      },
    }));
  } catch {
    snapshotNote += ' Incident could not be persisted.';
  }
  return [
    header,
    snapshotNote,
    `Restored ${String(result.applied.length)}/${String(plan.changes.length)} role(s). Incident ${incident.id}.`,
    ...result.failed.map(
      (failure) => `• FAILED ${failure.name} (${failure.roleId}): ${failure.error}`,
    ),
    ...formatSkips(plan),
  ].join('\n');
}
