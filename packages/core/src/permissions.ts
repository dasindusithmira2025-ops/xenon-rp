/**
 * The capability catalogue.
 *
 * Authorization is capability-based, never role-name-based. Code asks "may this
 * actor approve an application", never "is this actor an admin". Roles are just
 * bundles of capabilities that staff can rearrange without a deploy, and the
 * only place a Discord role snowflake appears is the DiscordRoleMapping table.
 *
 * This object is the single source of truth: the seed script writes rows from
 * it, the permission matrix UI renders from it, and `PermissionKey` is derived
 * from it, so a typo in a capability string is a type error.
 */
export const permissionCatalogue = {
  applications: {
    label: 'Applications',
    permissions: {
      'applications.view': 'See submitted applications and their answers.',
      'applications.review': 'Claim an application and record review notes.',
      'applications.assign': 'Assign an application to another reviewer.',
      'applications.approve': 'Approve an application, granting whatever it confers.',
      'applications.reject': 'Reject an application.',
      'applications.request_changes': 'Send an application back to the applicant for edits.',
      'applications.interview': 'Request, schedule and record interviews.',
      'applications.manage_templates': 'Create, edit and archive application templates.',
    },
  },
  players: {
    label: 'Players',
    permissions: {
      'players.view': 'View player accounts, characters and history.',
      'players.manage': 'Edit player profiles and linked game identities.',
      'players.whitelist': 'Grant, suspend and revoke whitelist access.',
      'players.ban': 'Suspend or ban a player account.',
    },
  },
  tickets: {
    label: 'Support',
    permissions: {
      'tickets.view': 'View support tickets.',
      'tickets.reply': 'Reply to support tickets.',
      'tickets.manage': 'Assign, re-categorise, resolve and close tickets.',
    },
  },
  reports: {
    label: 'Reports',
    permissions: {
      'reports.view': 'View player and bug reports.',
      'reports.manage': 'Action and close player and bug reports.',
      // Staff reports are separated deliberately. A report accusing a staff
      // member must not be visible to every staff member, including the subject.
      'reports.staff.view': 'View reports filed against staff members.',
      'reports.staff.manage': 'Action reports filed against staff members.',
    },
  },
  appeals: {
    label: 'Appeals',
    permissions: {
      'appeals.view': 'View ban and revocation appeals.',
      'appeals.manage': 'Decide ban and revocation appeals.',
    },
  },
  content: {
    label: 'Content',
    permissions: {
      'content.view': 'View unpublished news, gallery and page content.',
      'content.edit': 'Create and edit content drafts.',
      'content.publish': 'Publish content to the public site.',
    },
  },
  rules: {
    label: 'Rules',
    permissions: {
      'rules.edit': 'Edit rule text and create revisions.',
      'rules.publish': 'Publish a new ruleset version that players must accept.',
    },
  },
  departments: {
    label: 'Departments',
    permissions: {
      'departments.view': 'View department rosters.',
      'departments.manage': 'Edit departments, rosters and recruitment state.',
    },
  },
  staff: {
    label: 'Staff',
    permissions: {
      'staff.view': 'View the staff roster and role assignments.',
      'staff.manage': 'Assign and remove roles, and edit role permissions.',
    },
  },
  integrations: {
    label: 'Integrations',
    permissions: {
      'discord.manage': 'Configure Discord guild settings and role mappings.',
      'fivem.manage': 'Configure game servers and trigger whitelist synchronisation.',
    },
  },
  system: {
    label: 'System',
    permissions: {
      'audit.view': 'Read the audit log.',
      'system.manage': 'Change system settings and feature flags.',
    },
  },
} as const satisfies Record<string, { label: string; permissions: Record<string, string> }>;

export type PermissionCategory = keyof typeof permissionCatalogue;

type PermissionsOf<C extends PermissionCategory> =
  keyof (typeof permissionCatalogue)[C]['permissions'] & string;

/** Every capability string in the catalogue, as a literal union. */
export type PermissionKey = { [C in PermissionCategory]: PermissionsOf<C> }[PermissionCategory];

export interface PermissionDefinition {
  readonly key: PermissionKey;
  readonly category: PermissionCategory;
  readonly categoryLabel: string;
  readonly description: string;
}

/** Flattened catalogue, in catalogue order. Used by the seed and the admin UI. */
export const allPermissions: readonly PermissionDefinition[] = Object.entries(
  permissionCatalogue,
).flatMap(([category, group]) =>
  Object.entries(group.permissions).map(([key, description]) => ({
    key: key as PermissionKey,
    category: category as PermissionCategory,
    categoryLabel: group.label,
    description,
  })),
);

const permissionKeySet: ReadonlySet<string> = new Set(allPermissions.map((p) => p.key));

/** Narrow an arbitrary string from the database to a known capability. */
export function isPermissionKey(value: string): value is PermissionKey {
  return permissionKeySet.has(value);
}
