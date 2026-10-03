/**
 * Shared vocabulary of the Discord provisioning engine.
 *
 * Everything here is plain data. Permissions are `bigint` bitfields in memory
 * and decimal strings whenever they cross into JSON (a stored plan, the
 * Control Center), because JSON has no bigint and a float would silently drop
 * the high permission bits.
 *
 * Two identities exist for every resource and must never be confused:
 *
 *  - the logical key (`channel.welcome`) is configuration identity, stable
 *    across guilds, versions and re-creations;
 *  - the snowflake is a runtime mapping, stored in the managed resource
 *    registry and nowhere in the blueprint.
 */

export const BLUEPRINT_VERSION = 'discord-blueprint-v1';

export type ResourceType =
  'ROLE' | 'CATEGORY' | 'CHANNEL' | 'EMOJI' | 'STICKER' | 'PANEL' | 'SPACE' | 'AUTOMOD';

export type ChannelKind = 'text' | 'announcement' | 'forum' | 'voice';

/**
 * Who a channel is for. Drives the critical permission tests: a channel's
 * visibility is what the effective-access audit holds its overwrites to.
 */
export type Visibility =
  | { readonly scope: 'public' }
  | { readonly scope: 'staff' }
  | { readonly scope: 'management' }
  | { readonly scope: 'department'; readonly slug: string }
  | { readonly scope: 'department-command'; readonly slug: string }
  | { readonly scope: 'organization'; readonly key: string };

/** How much a grant lets an audience do. Mapped to bits per channel kind. */
export type Access = 'read' | 'write' | 'moderate';

/**
 * An audience in a policy.
 *
 * `@everyone` and `bot` are special; anything else is a role logical key or a
 * `group:` alias expanded from the blueprint's role groups.
 */
export type Audience = string;

export interface PolicyGrant {
  readonly audience: Audience;
  readonly access: Access;
}

export interface PermissionPolicy {
  readonly name: string;
  readonly description: string;
  /** What @everyone gets. `hidden` denies View Channel outright. */
  readonly everyone: 'hidden' | Access;
  readonly grants: readonly PolicyGrant[];
  readonly visibility: Visibility;
}

export interface DesiredRole {
  readonly key: string;
  readonly name: string;
  readonly color: number;
  readonly hoist: boolean;
  readonly mentionable: boolean;
  /** Guild-level permissions. Almost always zero: access comes from channels. */
  readonly permissions: bigint;
  readonly tier:
    'management' | 'staff' | 'player' | 'department' | 'organization' | 'notification' | 'language';
  /** Only roles marked here may ever be self-assigned through a panel. */
  readonly selfAssignable: boolean;
  /** Label and emoji shown in the self-role selector. */
  readonly selfRoleLabel?: string;
  readonly selfRoleEmoji?: string;
  /** Xenon role this Discord role mirrors, written to DiscordRoleMapping. */
  readonly xenonRoleKey?: string;
  /** Asset path of a role icon; applied only where the guild supports it. */
  readonly icon?: string;
}

export interface ForumTag {
  readonly name: string;
  readonly emoji?: string;
}

export interface DesiredChannel {
  readonly key: string;
  readonly name: string;
  readonly kind: 'category' | ChannelKind;
  /** Category logical key. */
  readonly parent?: string;
  readonly topic?: string;
  /**
   * Categories always carry a policy. A channel that names none inherits its
   * category's overwrites, which keeps the server free of redundant overrides.
   */
  readonly policy?: string;
  readonly slowmodeSeconds?: number;
  readonly userLimit?: number;
  readonly forumTags?: readonly ForumTag[];
  /** Xenon setting this channel's id is written to after provisioning. */
  readonly integration?: 'reviewChannel' | 'announcementChannel' | 'logChannel';
  /** Maintained automatically when enforcement is ENFORCE. */
  readonly critical?: boolean;
  /** Bot needs Manage Channels / Move Members here (temporary voice). */
  readonly botManages?: boolean;
}

/** A resolved permission overwrite. `id` is a logical audience until resolved. */
export interface Overwrite {
  readonly id: string;
  readonly type: 'role' | 'member';
  readonly allow: bigint;
  readonly deny: bigint;
}

export interface DesiredChannelState extends DesiredChannel {
  /** Kind actually used after capability fallbacks (forum → text, …). */
  readonly effectiveKind: 'category' | ChannelKind;
  readonly overwrites: readonly Overwrite[];
  readonly visibility: Visibility;
  /** True when the channel carries no overwrites of its own. */
  readonly inherits: boolean;
}

export type PanelKind =
  | 'welcome'
  | 'support'
  | 'rules'
  | 'how-to-join'
  | 'city-status'
  | 'choose-roles'
  | 'applications'
  | 'staff'
  | 'departments'
  | 'department-recruitment';

export interface DesiredPanel {
  readonly key: string;
  readonly kind: PanelKind;
  readonly channel: string;
  /** Live panels are refreshed by the bot; the plan only ensures they exist. */
  readonly live: boolean;
  /** For department panels. */
  readonly departmentSlug?: string;
}

export interface DesiredAsset {
  readonly key: string;
  readonly type: 'EMOJI' | 'STICKER';
  readonly name: string;
  readonly file: string;
  readonly hash: string;
  readonly animated: boolean;
  readonly priority: number;
  readonly required: boolean;
  /** Sticker only: the related unicode emoji Discord requires. */
  readonly tags?: string;
  readonly description?: string;
}

export interface DesiredAutoModRule {
  readonly key: string;
  readonly name: string;
  readonly trigger:
    | { readonly type: 'mention-spam'; readonly limit: number }
    | { readonly type: 'keyword'; readonly regex: readonly string[] }
    | { readonly type: 'spam' };
  /** Block the message, and alert to this channel key when set. */
  readonly alertChannel?: string;
  readonly exemptRoles: readonly string[];
}

export interface ManualStep {
  readonly key: string;
  readonly title: string;
  readonly reason: string;
  readonly steps: readonly string[];
}

export interface DesiredState {
  readonly version: string;
  readonly roles: readonly DesiredRole[];
  readonly channels: readonly DesiredChannelState[];
  readonly panels: readonly DesiredPanel[];
  readonly assets: readonly DesiredAsset[];
  readonly automod: readonly DesiredAutoModRule[];
  /** Blueprint features that had to fall back, e.g. forum → text. */
  readonly fallbacks: readonly { readonly key: string; readonly message: string }[];
  readonly manualSetup: readonly ManualStep[];
  /** Role groups used by policies, e.g. `staff` → [role.staff.moderator, …]. */
  readonly groups: Readonly<Record<string, readonly string[]>>;
}

// --- Actual guild state ------------------------------------------------------

export interface SnapshotRole {
  readonly id: string;
  readonly name: string;
  readonly color: number;
  readonly hoist: boolean;
  readonly mentionable: boolean;
  readonly permissions: bigint;
  readonly position: number;
  /** Integration / booster roles that nobody can assign. */
  readonly managed: boolean;
}

export interface SnapshotChannel {
  readonly id: string;
  readonly name: string;
  readonly kind: 'category' | ChannelKind | 'other';
  readonly parentId: string | null;
  readonly position: number;
  readonly topic: string | null;
  readonly overwrites: readonly Overwrite[];
  readonly userLimit?: number;
  readonly slowmodeSeconds?: number;
}

export interface GuildSnapshot {
  readonly id: string;
  readonly name: string;
  readonly ownerId: string;
  readonly features: readonly string[];
  readonly premiumTier: number;
  readonly bot: {
    readonly userId: string;
    readonly roleIds: readonly string[];
    readonly highestRolePosition: number;
    /** Guild-level permissions of the bot member. */
    readonly permissions: bigint;
  };
  readonly roles: readonly SnapshotRole[];
  readonly channels: readonly SnapshotChannel[];
  readonly emojis: readonly {
    readonly id: string;
    readonly name: string;
    readonly animated: boolean;
  }[];
  readonly stickers: readonly { readonly id: string; readonly name: string }[];
  /** `channelId:messageId` for every panel message that still exists. */
  readonly panelMessages: ReadonlySet<string>;
  readonly automodRules: readonly {
    readonly id: string;
    readonly name: string;
    readonly enabled: boolean;
  }[];
}

// --- Registry ----------------------------------------------------------------

export interface RegistryEntry {
  readonly logicalKey: string;
  readonly resourceType: ResourceType;
  readonly discordId: string | null;
  readonly channelId: string | null;
  readonly managed: boolean;
  readonly contentHash: string | null;
  readonly configurationHash: string | null;
  readonly createdByRunId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

// --- Plan --------------------------------------------------------------------

export type ChangeKind =
  | 'CREATE'
  | 'UPDATE'
  | 'MOVE'
  | 'PERMISSION_CHANGE'
  | 'UNCHANGED'
  | 'DRIFT'
  | 'CONFLICT'
  | 'MANUAL_REVIEW'
  | 'CAPACITY_BLOCKED';

export type Phase =
  'ROLES' | 'CATEGORIES' | 'CHANNELS' | 'PERMISSIONS' | 'ASSETS' | 'PANELS' | 'AUTOMOD';

export interface FieldChange {
  readonly field: string;
  readonly from: string;
  readonly to: string;
  /** Strict fields are repaired by default; soft ones only on request. */
  readonly strict: boolean;
}

export interface PlanItem {
  readonly key: string;
  readonly resourceType: ResourceType;
  readonly kind: ChangeKind;
  readonly phase: Phase;
  readonly label: string;
  readonly summary: string;
  readonly changes: readonly FieldChange[];
  readonly discordId: string | null;
  /** Set on CONFLICT: the unmanaged resource that already holds the name. */
  readonly conflict?: { readonly id: string; readonly name: string };
  /** Why an item cannot proceed (unresolved parent conflict, hierarchy …). */
  readonly blockedBy?: string;
  /** DRIFT only: whether any strict field drifted. */
  readonly strictDrift?: boolean;
}

export type DiagnosticCode =
  | 'BOT_ROLE_TOO_LOW'
  | 'ROLE_ABOVE_BOT'
  | 'MISSING_MANAGE_ROLES'
  | 'MISSING_BOOTSTRAP_PERMISSION'
  | 'DUPLICATE_ROLE'
  | 'UNKNOWN_ROLE'
  | 'UNMANAGED_ROLE'
  | 'ROLE_MAPPING_CONFLICT'
  | 'CAPABILITY_FALLBACK'
  | 'CAPACITY_BLOCKED'
  | 'LOCALHOST_LINK'
  | 'PERMISSION_LEAK'
  | 'DANGEROUS_ROLE_PERMISSION'
  | 'STAFF_CANNOT_SEE'
  | 'UNMANAGED_OVERWRITE'
  | 'ADMINISTRATOR_GRANTED';

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: 'critical' | 'error' | 'warning' | 'info';
  readonly message: string;
  readonly key?: string;
}

export type GuildProfile = 'EMPTY' | 'MANAGED' | 'ESTABLISHED';

export interface PlanCounts {
  readonly create: number;
  readonly update: number;
  readonly move: number;
  readonly permission: number;
  readonly unchanged: number;
  readonly drift: number;
  readonly conflict: number;
  readonly manual: number;
  readonly capacity: number;
}

export interface Plan {
  readonly version: string;
  readonly guildId: string;
  readonly guildName: string;
  readonly generatedAt: string;
  readonly profile: GuildProfile;
  readonly items: readonly PlanItem[];
  readonly diagnostics: readonly Diagnostic[];
  readonly manualSetup: readonly ManualStep[];
  readonly counts: PlanCounts;
  /** Sorted `key:kind` of every mutating item; what an approval approves. */
  readonly signature: readonly string[];
}
