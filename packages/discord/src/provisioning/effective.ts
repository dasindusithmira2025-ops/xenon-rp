import { PermissionFlagsBits as P } from 'discord.js';

import type { DesiredState, Diagnostic, Overwrite, Visibility } from './types';

/**
 * Effective permissions and the critical access audit.
 *
 * Discord's algorithm, reimplemented so the audit can run against the desired
 * state before anything is created and against the real guild afterwards:
 *
 *   base    = @everyone | every role the member holds (Administrator = all)
 *   channel = base, then @everyone overwrite, then the union of role
 *             overwrites (deny before allow), then the member overwrite
 *
 * Representative personas are pushed through it for every managed channel,
 * and anything that can see what its visibility says it must not is a
 * critical failure. That is the check that fails a provision when staff
 * content is accidentally public.
 */

const ALL = (1n << 64n) - 1n;

/** Guild permissions no player-facing role should ever carry. */
export const DANGEROUS_BITS =
  P.Administrator |
  P.ManageGuild |
  P.ManageRoles |
  P.ManageChannels |
  P.ManageWebhooks |
  P.ManageGuildExpressions |
  P.ManageEvents |
  P.BanMembers |
  P.KickMembers |
  P.ModerateMembers |
  P.ManageMessages |
  P.ManageThreads |
  P.ManageNicknames |
  P.MentionEveryone |
  P.ViewAuditLog |
  P.MoveMembers |
  P.MuteMembers |
  P.DeafenMembers;

export interface PermissionModel {
  readonly everyoneId: string;
  /** Guild-level permissions per role id, @everyone included. */
  readonly rolePermissions: ReadonlyMap<string, bigint>;
}

export function basePermissions(model: PermissionModel, roleIds: readonly string[]): bigint {
  let permissions = model.rolePermissions.get(model.everyoneId) ?? 0n;
  for (const roleId of roleIds) permissions |= model.rolePermissions.get(roleId) ?? 0n;
  return (permissions & P.Administrator) === P.Administrator ? ALL : permissions;
}

export function channelPermissions(
  model: PermissionModel,
  overwrites: readonly Overwrite[],
  roleIds: readonly string[],
  memberId?: string,
): bigint {
  const base = basePermissions(model, roleIds);
  if (base === ALL) return ALL;

  let permissions = base;
  const everyone = overwrites.find((o) => o.type === 'role' && o.id === model.everyoneId);
  if (everyone !== undefined) {
    permissions &= ~everyone.deny;
    permissions |= everyone.allow;
  }

  const held = new Set(roleIds);
  let allow = 0n;
  let deny = 0n;
  for (const overwrite of overwrites) {
    if (overwrite.type === 'role' && held.has(overwrite.id)) {
      allow |= overwrite.allow;
      deny |= overwrite.deny;
    }
  }
  permissions &= ~deny;
  permissions |= allow;

  if (memberId !== undefined) {
    const member = overwrites.find((o) => o.type === 'member' && o.id === memberId);
    if (member !== undefined) {
      permissions &= ~member.deny;
      permissions |= member.allow;
    }
  }
  return permissions;
}

export interface Persona {
  readonly name: string;
  /** Logical role keys. */
  readonly roles: readonly string[];
  readonly isBot?: boolean;
}

/** Representative members, derived from whatever the blueprint contains. */
export function personasFor(state: DesiredState): Persona[] {
  const has = (key: string) => state.roles.some((role) => role.key === key);
  const citizen = has('role.citizen') ? ['role.citizen'] : [];
  const whitelisted = [...citizen, ...(has('role.whitelisted') ? ['role.whitelisted'] : [])];

  const personas: Persona[] = [
    { name: '@everyone', roles: [] },
    { name: 'Citizen', roles: citizen },
    { name: 'Whitelisted', roles: whitelisted },
    {
      name: 'Subscriber (every self-assignable role)',
      roles: [
        ...whitelisted,
        ...state.roles.filter((role) => role.selfAssignable).map((role) => role.key),
      ],
    },
  ];
  if (has('role.creator')) {
    personas.push({ name: 'Content Creator', roles: [...whitelisted, 'role.creator'] });
  }

  for (const role of state.roles) {
    if (role.tier === 'management' || role.tier === 'staff') {
      personas.push({ name: role.name, roles: [role.key] });
    }
    if (role.tier === 'organization') {
      personas.push({ name: `${role.name} member`, roles: [...whitelisted, role.key] });
    }
  }

  const departmentSlugs = new Set(
    state.roles
      .filter((role) => role.tier === 'department')
      .map((role) => role.key.split('.')[2] ?? ''),
  );
  for (const slug of departmentSlugs) {
    const member = `role.dept.${slug}.member`;
    const command = `role.dept.${slug}.command`;
    personas.push(
      { name: `${slug} member`, roles: [...whitelisted, member] },
      { name: `${slug} command`, roles: [...whitelisted, member, command] },
    );
  }

  personas.push({ name: 'Xenon Bot', roles: [], isBot: true });
  return personas;
}

function mayView(
  persona: Persona,
  visibility: Visibility,
  groups: Readonly<Record<string, readonly string[]>>,
): boolean {
  if (persona.isBot === true) return true;
  const held = new Set(persona.roles);
  const inGroup = (group: string) => (groups[group] ?? []).some((key) => held.has(key));

  switch (visibility.scope) {
    case 'public':
      return true;
    case 'staff':
      return inGroup('staff');
    case 'management':
      return inGroup('management');
    case 'department':
      return (
        held.has(`role.dept.${visibility.slug}.member`) ||
        held.has(`role.dept.${visibility.slug}.command`) ||
        inGroup('management')
      );
    case 'department-command':
      return held.has(`role.dept.${visibility.slug}.command`) || inGroup('management');
    case 'organization':
      return held.has(`role.org.${visibility.key}`) || inGroup('management');
  }
}

/** Should this persona be able to see it? Used to flag staff locked out. */
function expectsView(persona: Persona, visibility: Visibility): boolean {
  return visibility.scope === 'staff' && persona.roles.length === 1 && persona.isBot !== true;
}

export interface AuditChannel {
  readonly key: string;
  readonly label: string;
  readonly overwrites: readonly Overwrite[];
  readonly visibility: Visibility;
}

export interface AccessRow {
  readonly key: string;
  readonly label: string;
  readonly visibility: string;
  readonly access: readonly {
    readonly persona: string;
    readonly view: boolean;
    readonly send: boolean;
    readonly manage: boolean;
  }[];
}

export interface AuditInput {
  readonly state: DesiredState;
  readonly model: PermissionModel;
  readonly channels: readonly AuditChannel[];
  /** Logical key → id in `model`. Identity for the desired-state audit. */
  readonly resolve: (logical: string) => string | null;
  readonly botMemberId: string;
  /** Roles the bot holds, in `model` ids. Empty for the desired-state audit. */
  readonly botRoleIds: readonly string[];
  /** Role ids Xenon manages; any other role granted View on a restricted channel is reported. */
  readonly managedRoleIds: ReadonlySet<string>;
}

export interface AuditResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly matrix: readonly AccessRow[];
  /** True when no critical diagnostic was raised. */
  readonly passed: boolean;
}

function visibilityLabel(visibility: Visibility): string {
  switch (visibility.scope) {
    case 'public':
    case 'staff':
    case 'management':
      return visibility.scope;
    case 'department':
    case 'department-command':
      return `${visibility.scope}:${visibility.slug}`;
    case 'organization':
      return `organization:${visibility.key}`;
  }
}

/**
 * Run the critical access tests.
 *
 * Works on either model: the desired state with logical ids (before apply), or
 * the live snapshot with snowflakes (after apply, and on every status check).
 */
export function auditPermissions(input: AuditInput): AuditResult {
  const { state, model, resolve } = input;
  const diagnostics: Diagnostic[] = [];
  const personas = personasFor(state);

  const everyone = model.rolePermissions.get(model.everyoneId) ?? 0n;
  if ((everyone & DANGEROUS_BITS) !== 0n) {
    diagnostics.push({
      code: 'DANGEROUS_ROLE_PERMISSION',
      severity: 'critical',
      message: '@everyone holds moderation or management permissions at server level.',
    });
  }

  for (const role of state.roles) {
    const id = resolve(role.key);
    if (id === null) continue;
    const bits = model.rolePermissions.get(id) ?? 0n;
    if ((bits & P.Administrator) !== 0n) {
      diagnostics.push({
        code: 'ADMINISTRATOR_GRANTED',
        severity: role.tier === 'management' ? 'warning' : 'critical',
        message: `${role.name} holds Administrator, which bypasses every channel policy.`,
        key: role.key,
      });
    }
    const playerFacing = role.tier !== 'management' && role.tier !== 'staff';
    if (playerFacing && (bits & DANGEROUS_BITS) !== 0n) {
      diagnostics.push({
        code: 'DANGEROUS_ROLE_PERMISSION',
        severity: 'critical',
        message: `${role.name} is a ${role.tier} role but holds moderation or management permissions.`,
        key: role.key,
      });
    }
  }

  const selfAssignableIds = new Set(
    state.roles
      .filter((role) => role.selfAssignable)
      .map((role) => resolve(role.key))
      .filter((id): id is string => id !== null),
  );

  const matrix: AccessRow[] = [];
  for (const channel of input.channels) {
    const access = personas.map((persona) => {
      const roleIds =
        persona.isBot === true
          ? input.botRoleIds
          : persona.roles.map(resolve).filter((id): id is string => id !== null);
      const bits = channelPermissions(
        model,
        channel.overwrites,
        roleIds,
        persona.isBot === true ? input.botMemberId : undefined,
      );
      const view = (bits & P.ViewChannel) !== 0n;
      return {
        persona: persona.name,
        view,
        send: view && (bits & (P.SendMessages | P.Connect)) !== 0n,
        manage: view && (bits & (P.ManageMessages | P.ManageChannels | P.ManageRoles)) !== 0n,
        allowed: mayView(persona, channel.visibility, state.groups),
        expected: expectsView(persona, channel.visibility),
      };
    });

    for (const entry of access) {
      if (entry.view && !entry.allowed) {
        diagnostics.push({
          code: 'PERMISSION_LEAK',
          severity: 'critical',
          message: `${entry.persona} can see ${channel.label}, which is ${visibilityLabel(channel.visibility)} only.`,
          key: channel.key,
        });
      } else if (!entry.view && entry.expected) {
        diagnostics.push({
          code: 'STAFF_CANNOT_SEE',
          severity: 'warning',
          message: `${entry.persona} cannot see ${channel.label}.`,
          key: channel.key,
        });
      }
    }

    for (const overwrite of channel.overwrites) {
      if (overwrite.type !== 'role') continue;
      if (selfAssignableIds.has(overwrite.id) && overwrite.allow !== 0n) {
        diagnostics.push({
          code: 'DANGEROUS_ROLE_PERMISSION',
          severity: 'critical',
          message: `A self-assignable role is granted access on ${channel.label}; picking a notification role must never change what someone can do.`,
          key: channel.key,
        });
      }
      const restricted = channel.visibility.scope !== 'public';
      if (
        restricted &&
        overwrite.id !== model.everyoneId &&
        !input.managedRoleIds.has(overwrite.id) &&
        (overwrite.allow & P.ViewChannel) !== 0n
      ) {
        diagnostics.push({
          code: 'UNMANAGED_OVERWRITE',
          severity: 'warning',
          message: `An unmanaged role (${overwrite.id}) can view ${channel.label}. Confirm that is intended.`,
          key: channel.key,
        });
      }
    }

    matrix.push({
      key: channel.key,
      label: channel.label,
      visibility: visibilityLabel(channel.visibility),
      access: access.map(({ persona, view, send, manage }) => ({ persona, view, send, manage })),
    });
  }

  return {
    diagnostics,
    matrix,
    passed: !diagnostics.some((diagnostic) => diagnostic.severity === 'critical'),
  };
}

/** The desired-state audit: every id is its logical key and the bot holds everything. */
export function auditDesiredState(state: DesiredState): AuditResult {
  const rolePermissions = new Map<string, bigint>([['@everyone', 0n]]);
  for (const role of state.roles) rolePermissions.set(role.key, role.permissions);

  return auditPermissions({
    state,
    model: { everyoneId: '@everyone', rolePermissions },
    channels: state.channels.map((channel) => ({
      key: channel.key,
      label: channel.kind === 'category' ? channel.name : `#${channel.name}`,
      overwrites: channel.overwrites,
      visibility: channel.visibility,
    })),
    resolve: (key) => key,
    botMemberId: 'bot',
    botRoleIds: [],
    managedRoleIds: new Set(state.roles.map((role) => role.key)),
  });
}
