import { allPermissions, type PermissionKey } from './permissions';

/**
 * Default role structure.
 *
 * These are starting points, not fixtures: every field is editable from
 * /control once seeded, and the community's actual rank names, colours and
 * Discord mappings are configured there rather than invented here. Only the
 * roles the platform itself depends on are marked `isSystem`.
 */
export interface RolePreset {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  /** Higher wins on conflict, and bounds who may assign whom. */
  readonly priority: number;
  /** Undeletable from the UI because platform behaviour assumes it exists. */
  readonly isSystem: boolean;
  /** `'*'` means every capability in the catalogue, now and in future. */
  readonly permissions: readonly PermissionKey[] | '*';
}

export const OWNER_ROLE_KEY = 'owner';
export const MEMBER_ROLE_KEY = 'member';

export const rolePresets: readonly RolePreset[] = [
  {
    key: OWNER_ROLE_KEY,
    name: 'Owner',
    description: 'Full control of the platform. Holds every capability, including future ones.',
    priority: 1000,
    isSystem: true,
    permissions: '*',
  },
  {
    key: 'administrator',
    name: 'Administrator',
    description: 'Runs the community day to day. Everything except system configuration.',
    priority: 900,
    isSystem: true,
    permissions: [
      'applications.view',
      'applications.review',
      'applications.assign',
      'applications.approve',
      'applications.reject',
      'applications.request_changes',
      'applications.interview',
      'applications.manage_templates',
      'players.view',
      'players.manage',
      'players.whitelist',
      'players.ban',
      'tickets.view',
      'tickets.reply',
      'tickets.manage',
      'reports.view',
      'reports.manage',
      'reports.staff.view',
      'reports.staff.manage',
      'appeals.view',
      'appeals.manage',
      'content.view',
      'content.edit',
      'content.publish',
      'rules.edit',
      'rules.publish',
      'departments.view',
      'departments.manage',
      'staff.view',
      'staff.manage',
      'discord.manage',
      'fivem.manage',
      'audit.view',
    ],
  },
  {
    key: 'moderator',
    name: 'Moderator',
    description: 'Handles players, support and reports. No access to staff reports or appeals.',
    priority: 700,
    isSystem: false,
    permissions: [
      'applications.view',
      'players.view',
      'players.manage',
      'players.ban',
      'tickets.view',
      'tickets.reply',
      'tickets.manage',
      'reports.view',
      'reports.manage',
      'departments.view',
    ],
  },
  {
    key: 'reviewer',
    name: 'Application Reviewer',
    description: 'Reviews and decides applications. No player moderation powers.',
    priority: 600,
    isSystem: false,
    permissions: [
      'applications.view',
      'applications.review',
      'applications.approve',
      'applications.reject',
      'applications.request_changes',
      'applications.interview',
      'players.view',
      'departments.view',
    ],
  },
  {
    key: 'support',
    name: 'Support',
    description: 'Answers tickets. Can see player accounts but cannot change them.',
    priority: 500,
    isSystem: false,
    permissions: ['tickets.view', 'tickets.reply', 'players.view'],
  },
  {
    key: 'content_editor',
    name: 'Content Editor',
    description: 'Writes news and curates the gallery. Cannot publish without review.',
    priority: 400,
    isSystem: false,
    permissions: ['content.view', 'content.edit', 'departments.view'],
  },
  {
    key: MEMBER_ROLE_KEY,
    name: 'Member',
    description: 'Every signed-in account. Holds no staff capabilities.',
    priority: 0,
    isSystem: true,
    permissions: [],
  },
];

/**
 * Expand a preset to concrete capabilities.
 *
 * `'*'` is resolved at seed time rather than stored as a wildcard, so the
 * permission matrix in /control shows Owner's real grants instead of a special
 * case the UI would have to know about. The seed is idempotent and re-runs on
 * deploy, which is what keeps Owner current as the catalogue grows.
 */
export function resolvePresetPermissions(preset: RolePreset): readonly PermissionKey[] {
  return preset.permissions === '*'
    ? allPermissions.map((permission) => permission.key)
    : preset.permissions;
}
