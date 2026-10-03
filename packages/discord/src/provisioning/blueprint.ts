import { createHash } from 'node:crypto';

import { PermissionFlagsBits as P } from 'discord.js';

import { brand } from '@xenon/config';

import { buildOverwrites, resolvePolicy } from './policies';
import {
  BLUEPRINT_VERSION,
  type DesiredAsset,
  type DesiredAutoModRule,
  type DesiredChannel,
  type DesiredChannelState,
  type DesiredPanel,
  type DesiredRole,
  type DesiredState,
  type ManualStep,
} from './types';

import type { BlueprintFeatures, DepartmentSpace, OrganizationSpace } from './config';

/**
 * The XenonRP Discord blueprint.
 *
 * Declarative, versioned, and deliberately small. It describes a server that
 * reads like a community that has existed for years: few channels, each with a
 * purpose, clean lowercase names, one emoji per category heading at most, and
 * permissions that come from a handful of named policies.
 *
 * The static part lives here. Departments and organisations are templates
 * expanded from Xenon's own records, so nothing in this file knows that LSPD
 * exists - a new department is a row in Postgres, not a deploy.
 */

export interface DepartmentInput {
  readonly slug: string;
  readonly name: string;
  readonly shortName: string | null;
  readonly accentColour: string | null;
  readonly roleKey: string | null;
  readonly recruitmentState: 'OPEN' | 'CLOSED' | 'WAITLIST' | 'INVITE_ONLY';
  readonly published: boolean;
  readonly space: DepartmentSpace;
}

export type OrganizationInput = OrganizationSpace;

export interface BlueprintContext {
  readonly features: BlueprintFeatures;
  readonly guildFeatures: readonly string[];
  readonly departments: readonly DepartmentInput[];
  readonly organizations: readonly OrganizationInput[];
  readonly assets: readonly DesiredAsset[];
}

// --- Roles -------------------------------------------------------------------

/**
 * Colour palette. Chrome for staff, Xenon green used exactly once - on the role
 * players earn - and no colour at all on notification roles, so the member list
 * communicates rank rather than looking like a rainbow.
 */
const palette = {
  chrome: 0xf5f7f5,
  silver: 0xd9ded9,
  steel: 0xb8bfb8,
  sage: 0x8fa88c,
  moss: 0x74866f,
  jade: 0x5e9e73,
  slate: 0x6e8f9e,
  brass: 0xc9a45c,
  creator: 0x9b7bd4,
  department: 0x7c8a96,
  none: 0,
} as const;

const MODERATION = P.ModerateMembers | P.ManageMessages | P.ManageThreads | P.ManageNicknames;
const SENIOR = MODERATION | P.KickMembers | P.BanMembers | P.ViewAuditLog | P.MentionEveryone;
const VOICE_MOD = P.MoveMembers | P.MuteMembers;

const staticRoles: readonly (DesiredRole & { feature?: keyof BlueprintFeatures })[] = [
  {
    key: 'role.staff.management',
    name: 'Management',
    color: palette.chrome,
    hoist: true,
    mentionable: false,
    permissions: SENIOR | VOICE_MOD,
    tier: 'management',
    selfAssignable: false,
    xenonRoleKey: 'owner',
  },
  {
    key: 'role.staff.head-admin',
    name: 'Head Administrator',
    color: palette.silver,
    hoist: true,
    mentionable: false,
    permissions: SENIOR | VOICE_MOD,
    tier: 'management',
    selfAssignable: false,
  },
  {
    key: 'role.staff.admin',
    name: 'Administrator',
    color: palette.steel,
    hoist: true,
    mentionable: false,
    permissions: SENIOR | VOICE_MOD,
    tier: 'staff',
    selfAssignable: false,
    xenonRoleKey: 'administrator',
  },
  {
    key: 'role.staff.moderator',
    name: 'Moderator',
    color: palette.sage,
    hoist: true,
    mentionable: false,
    permissions: MODERATION | P.KickMembers | VOICE_MOD,
    tier: 'staff',
    selfAssignable: false,
    xenonRoleKey: 'moderator',
  },
  {
    key: 'role.staff.trial-moderator',
    name: 'Trial Moderator',
    color: palette.moss,
    hoist: true,
    mentionable: false,
    permissions: P.ModerateMembers | P.ManageMessages,
    tier: 'staff',
    selfAssignable: false,
  },
  {
    key: 'role.staff.whitelist',
    name: 'Whitelist Team',
    color: palette.jade,
    hoist: true,
    mentionable: false,
    permissions: 0n,
    tier: 'staff',
    selfAssignable: false,
    xenonRoleKey: 'reviewer',
  },
  {
    key: 'role.staff.support',
    name: 'Support Team',
    color: palette.slate,
    hoist: true,
    mentionable: false,
    permissions: 0n,
    tier: 'staff',
    selfAssignable: false,
    xenonRoleKey: 'support',
  },
  {
    key: 'role.staff.events',
    name: 'Event Team',
    color: palette.brass,
    hoist: false,
    mentionable: false,
    permissions: 0n,
    tier: 'staff',
    selfAssignable: false,
  },
];

const playerRoles: readonly (DesiredRole & { feature?: keyof BlueprintFeatures })[] = [
  {
    key: 'role.creator',
    name: 'Content Creator',
    color: palette.creator,
    hoist: false,
    mentionable: false,
    permissions: 0n,
    tier: 'player',
    selfAssignable: false,
  },
  {
    key: 'role.whitelisted',
    name: 'Whitelisted',
    color: brand.greenInt,
    hoist: true,
    mentionable: false,
    permissions: 0n,
    tier: 'player',
    selfAssignable: false,
  },
  {
    key: 'role.citizen',
    name: 'Citizen',
    color: palette.none,
    hoist: false,
    mentionable: false,
    permissions: 0n,
    tier: 'player',
    selfAssignable: false,
    // Every account signed in to Xenon holds `member`, so Citizen means
    // "has a Xenon account" without anybody assigning it by hand.
    xenonRoleKey: 'member',
  },
  ...(
    [
      ['updates', 'Server Updates', '📣'],
      ['events', 'Events', '🎟️'],
      ['recruitment', 'Recruitment', '🧾'],
      ['community', 'Community Events', '🎉'],
      ['streams', 'Creator Streams', '🎥'],
    ] as const
  ).map(([slug, name, emoji]): DesiredRole => ({
    key: `role.notify.${slug}`,
    name,
    color: palette.none,
    hoist: false,
    // Pings go through Xenon (which holds Mention Everyone), never through
    // members pinging each other with a role they picked themselves.
    mentionable: false,
    permissions: 0n,
    tier: 'notification',
    selfAssignable: true,
    selfRoleLabel: name,
    selfRoleEmoji: emoji,
  })),
  ...(
    [
      ['en', 'English'],
      ['si', 'සිංහල'],
      ['ta', 'தமிழ்'],
    ] as const
  ).map(
    ([code, name]) =>
      ({
        key: `role.lang.${code}`,
        name,
        color: palette.none,
        hoist: false,
        mentionable: false,
        permissions: 0n,
        tier: 'language',
        selfAssignable: true,
        selfRoleLabel: name,
        feature: 'languageRoles',
      }) satisfies DesiredRole & { feature: keyof BlueprintFeatures },
  ),
];

function colourFromHex(hex: string | null): number {
  if (hex === null) return palette.department;
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  return match?.[1] === undefined ? palette.department : Number.parseInt(match[1], 16);
}

function departmentLabel(department: DepartmentInput): string {
  return department.shortName ?? department.name;
}

/** A short stable code, so a private organisation's role never names it. */
function codename(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 4).toUpperCase();
}

// --- Channels ----------------------------------------------------------------

type ChannelDef = DesiredChannel & { feature?: keyof BlueprintFeatures };

const staticChannels: readonly ChannelDef[] = [
  { key: 'category.start', name: '🧭 Start Here', kind: 'category', policy: 'PUBLIC_READ_ONLY' },
  {
    key: 'channel.welcome',
    name: 'welcome',
    kind: 'text',
    parent: 'category.start',
    topic: 'Welcome to XenonRP. One city, thousands of stories.',
  },
  {
    key: 'channel.rules',
    name: 'rules',
    kind: 'text',
    parent: 'category.start',
    topic: 'The essentials. The complete rulebook lives on the Xenon website.',
  },
  {
    key: 'channel.how-to-join',
    name: 'how-to-join',
    kind: 'text',
    parent: 'category.start',
    topic: 'Six steps from Discord to the city.',
  },
  {
    key: 'channel.city-status',
    name: 'city-status',
    kind: 'text',
    parent: 'category.start',
    policy: 'BOT_ONLY',
    topic: 'Live status of the city. Updated automatically.',
    critical: true,
  },
  {
    key: 'channel.support',
    name: 'support',
    kind: 'text',
    parent: 'category.start',
    topic: 'Choose a category to open the right Xenon support workflow.',
  },
  {
    key: 'channel.faq',
    name: 'faq',
    kind: 'text',
    parent: 'category.start',
    topic: 'Answers to what everyone asks first.',
    feature: 'faq',
  },
  {
    key: 'channel.choose-roles',
    name: 'choose-roles',
    kind: 'text',
    parent: 'category.start',
    topic: 'Pick the updates you want to be pinged for.',
  },

  { key: 'category.news', name: '📰 City News', kind: 'category', policy: 'PUBLIC_READ_ONLY' },
  {
    key: 'channel.announcements',
    name: 'announcements',
    kind: 'announcement',
    parent: 'category.news',
    topic: 'Official XenonRP announcements. Published from the Xenon website.',
    integration: 'announcementChannel',
  },
  {
    key: 'channel.patch-notes',
    name: 'patch-notes',
    kind: 'announcement',
    parent: 'category.news',
    topic: 'What changed in the city, release by release.',
    feature: 'patchNotes',
  },
  {
    key: 'channel.events',
    name: 'events',
    kind: 'announcement',
    parent: 'category.news',
    topic: 'Community events, dates and details.',
    feature: 'events',
  },

  { key: 'category.community', name: '💬 Community', kind: 'category', policy: 'PUBLIC_CHAT' },
  {
    key: 'channel.general',
    name: 'general',
    kind: 'text',
    parent: 'category.community',
    topic: 'The city square. Keep it friendly.',
  },
  {
    key: 'channel.introductions',
    name: 'introductions',
    kind: 'text',
    parent: 'category.community',
    topic: 'New here? Say hello.',
    slowmodeSeconds: 300,
    feature: 'introductions',
  },
  {
    key: 'channel.media',
    name: 'media',
    kind: 'text',
    parent: 'category.community',
    topic: 'Screenshots, art and edits from the city.',
    slowmodeSeconds: 30,
    feature: 'media',
  },
  {
    key: 'channel.clips',
    name: 'clips',
    kind: 'text',
    parent: 'category.community',
    topic: 'The moments worth rewatching.',
    slowmodeSeconds: 30,
    feature: 'clips',
  },
  {
    key: 'channel.screenshots',
    name: 'screenshots',
    kind: 'text',
    parent: 'category.community',
    topic: 'Stills from the streets.',
    slowmodeSeconds: 30,
    feature: 'screenshots',
  },
  {
    key: 'channel.suggestions',
    name: 'suggestions',
    kind: 'forum',
    parent: 'category.community',
    topic:
      'One idea per post. Say what you want, why it makes the city better, and how it should work.',
    forumTags: [
      { name: 'Gameplay', emoji: '🎮' },
      { name: 'Vehicles', emoji: '🚗' },
      { name: 'Jobs', emoji: '💼' },
      { name: 'Businesses', emoji: '🏪' },
      { name: 'Quality of Life', emoji: '✨' },
      { name: 'Discord', emoji: '💬' },
      { name: 'Website', emoji: '🌐' },
      { name: 'Other', emoji: '📎' },
    ],
    feature: 'suggestions',
  },
  {
    key: 'channel.community-help',
    name: 'community-help',
    kind: 'forum',
    parent: 'category.community',
    topic:
      'Community help from other players. Private or account issues go to Xenon support on the website.',
    forumTags: [
      { name: 'Getting Started', emoji: '🧭' },
      { name: 'Technical', emoji: '🛠️' },
      { name: 'Gameplay', emoji: '🎮' },
      { name: 'Solved', emoji: '✅' },
    ],
    feature: 'communityHelp',
  },
  {
    key: 'channel.off-topic',
    name: 'off-topic',
    kind: 'text',
    parent: 'category.community',
    topic: 'Everything that is not the city.',
    feature: 'offTopic',
  },

  {
    key: 'category.city-info',
    name: '🏙️ City Information',
    kind: 'category',
    policy: 'PUBLIC_READ_ONLY',
  },
  {
    key: 'channel.city-guide',
    name: 'city-guide',
    kind: 'text',
    parent: 'category.city-info',
    topic: 'Getting around Xenon.',
    feature: 'cityGuide',
  },
  {
    key: 'channel.departments',
    name: 'departments',
    kind: 'text',
    parent: 'category.city-info',
    topic: 'The services that keep the city running.',
    feature: 'departmentsDirectory',
  },
  {
    key: 'channel.business-directory',
    name: 'business-directory',
    kind: 'text',
    parent: 'category.city-info',
    topic: 'Open for business.',
    feature: 'businessDirectory',
  },
  {
    key: 'channel.laws',
    name: 'laws',
    kind: 'text',
    parent: 'category.city-info',
    topic: 'The law of the city.',
    feature: 'laws',
  },
  {
    key: 'channel.commands',
    name: 'commands',
    kind: 'text',
    parent: 'category.city-info',
    topic: 'In-city commands and controls.',
    feature: 'commands',
  },

  {
    key: 'category.applications',
    name: '📝 Applications',
    kind: 'category',
    policy: 'PUBLIC_READ_ONLY',
  },
  {
    key: 'channel.applications',
    name: 'applications',
    kind: 'text',
    parent: 'category.applications',
    topic: 'Apply on the Xenon website. Status and availability are shown here.',
  },
  {
    key: 'channel.whitelist-info',
    name: 'whitelist-info',
    kind: 'text',
    parent: 'category.applications',
    topic: 'What the whitelist is and how it is reviewed.',
    feature: 'whitelistInfo',
  },
  {
    key: 'channel.recruitment',
    name: 'recruitment',
    kind: 'text',
    parent: 'category.applications',
    topic: 'Departments currently hiring.',
    feature: 'recruitment',
  },

  { key: 'category.voice', name: '🔊 Voice', kind: 'category', policy: 'PUBLIC_CHAT' },
  { key: 'voice.general', name: 'General', kind: 'voice', parent: 'category.voice' },
  {
    key: 'voice.chill',
    name: 'Chill',
    kind: 'voice',
    parent: 'category.voice',
    feature: 'voiceLounges',
  },
  {
    key: 'voice.gaming',
    name: 'Gaming',
    kind: 'voice',
    parent: 'category.voice',
    feature: 'voiceLounges',
  },
  {
    key: 'voice.create-room',
    name: '➕ Create Room',
    kind: 'voice',
    parent: 'category.voice',
    feature: 'tempVoice',
    userLimit: 1,
  },
  { key: 'voice.afk', name: 'AFK', kind: 'voice', parent: 'category.voice' },

  { key: 'category.staff', name: '🛡️ Staff HQ', kind: 'category', policy: 'STAFF_ONLY' },
  {
    key: 'channel.staff-announcements',
    name: 'staff-announcements',
    kind: 'text',
    parent: 'category.staff',
    policy: 'STAFF_ANNOUNCE',
    topic: 'Notices from management.',
  },
  {
    key: 'channel.staff-chat',
    name: 'staff-chat',
    kind: 'text',
    parent: 'category.staff',
    topic: 'Staff conversation.',
  },
  {
    key: 'channel.whitelist-review',
    name: 'whitelist-review',
    kind: 'text',
    parent: 'category.staff',
    topic: 'Whitelist applications arrive here. Decide on the card or in Xenon Control.',
    integration: 'reviewChannel',
    critical: true,
  },
  {
    key: 'channel.application-review',
    name: 'application-review',
    kind: 'text',
    parent: 'category.staff',
    topic: 'Department and staff applications, when a template routes here.',
    feature: 'applicationReview',
  },
  {
    key: 'channel.mod-alerts',
    name: 'mod-alerts',
    kind: 'text',
    parent: 'category.staff',
    topic: 'AutoMod alerts. Blocked messages are logged here, never actioned automatically.',
    feature: 'automod',
  },
  {
    key: 'channel.staff-resources',
    name: 'staff-resources',
    kind: 'text',
    parent: 'category.staff',
    topic: 'Procedures and references.',
    feature: 'staffResources',
  },
  { key: 'voice.staff-lounge', name: 'Staff Lounge', kind: 'voice', parent: 'category.staff' },
  { key: 'voice.staff-meeting', name: 'Staff Meeting', kind: 'voice', parent: 'category.staff' },

  { key: 'category.ops', name: '⚙️ Xenon Ops', kind: 'category', policy: 'MANAGEMENT_ONLY' },
  {
    key: 'channel.bot-ops',
    name: 'bot-logs',
    kind: 'text',
    parent: 'category.ops',
    topic: 'Provisioning runs, drift and integration health. Canonical logs live in Xenon.',
    integration: 'logChannel',
  },
];

function departmentChannels(department: DepartmentInput): ChannelDef[] {
  const { slug, space } = department;
  const label = departmentLabel(department);
  const lower = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const channels: ChannelDef[] = [];

  if (space.publicInfo) {
    channels.push({
      key: `channel.dept.${slug}.info`,
      name: `${lower}-information`,
      kind: 'text',
      parent: 'category.city-info',
      policy: `DEPARTMENT_PUBLIC:${slug}`,
      topic: `About ${department.name}.`,
    });
  }
  if (space.recruitment) {
    channels.push({
      key: `channel.dept.${slug}.recruitment`,
      name: `${lower}-recruitment`,
      kind: 'text',
      parent: 'category.applications',
      policy: `DEPARTMENT_PUBLIC:${slug}`,
      topic: `Join ${department.name}.`,
    });
  }
  if (!space.private) return channels;

  const category = `category.dept.${slug}`;
  channels.push(
    {
      key: category,
      name: label,
      kind: 'category',
      policy: `DEPARTMENT_MEMBER:${slug}`,
    },
    {
      key: `channel.dept.${slug}.announcements`,
      name: 'announcements',
      kind: 'text',
      parent: category,
      policy: `DEPARTMENT_ANNOUNCE:${slug}`,
      topic: `Notices from ${label} command.`,
    },
    {
      key: `channel.dept.${slug}.general`,
      name: 'general',
      kind: 'text',
      parent: category,
      topic: `${label} conversation.`,
    },
    {
      key: `channel.dept.${slug}.resources`,
      name: 'resources',
      kind: 'text',
      parent: category,
      topic: 'Procedures, guides and references.',
    },
  );
  if (space.training) {
    channels.push({
      key: `channel.dept.${slug}.training`,
      name: 'training',
      kind: 'text',
      parent: category,
      topic: 'Training schedules and material.',
    });
  }
  if (space.command) {
    channels.push({
      key: `channel.dept.${slug}.command`,
      name: 'command',
      kind: 'text',
      parent: category,
      policy: `DEPARTMENT_COMMAND:${slug}`,
      topic: `${label} command only.`,
    });
  }
  if (space.voice) {
    channels.push(
      {
        key: `voice.dept.${slug}.briefing`,
        name: 'Briefing Room',
        kind: 'voice',
        parent: category,
      },
      { key: `voice.dept.${slug}.operations`, name: 'Operations', kind: 'voice', parent: category },
    );
  }
  return channels;
}

function organizationChannels(organization: OrganizationInput): ChannelDef[] {
  const category = `category.org.${organization.key}`;
  const policy = organization.archived
    ? 'ARCHIVED'
    : organization.staffVisible
      ? `ORGANIZATION_PRIVATE_STAFF:${organization.key}`
      : `ORGANIZATION_PRIVATE:${organization.key}`;

  return [
    {
      key: category,
      name: organization.archived ? `🗄️ Archived · ${organization.name}` : organization.name,
      kind: 'category',
      policy,
    },
    {
      key: `channel.org.${organization.key}.general`,
      name: 'general',
      kind: 'text',
      parent: category,
    },
    {
      key: `channel.org.${organization.key}.operations`,
      name: 'operations',
      kind: 'text',
      parent: category,
    },
    { key: `channel.org.${organization.key}.media`, name: 'media', kind: 'text', parent: category },
    { key: `voice.org.${organization.key}.voice`, name: 'Voice', kind: 'voice', parent: category },
  ];
}

// --- Assembly ----------------------------------------------------------------

/**
 * Expand the blueprint into the desired state for one guild.
 *
 * Pure: the same context always yields the same state, which is what lets the
 * plan be reproduced exactly by the slash command, the Control Center and the
 * CLI. Capability fallbacks happen here rather than at apply time so the plan
 * shows the operator what will actually be created.
 */
export function buildDesiredState(context: BlueprintContext): DesiredState {
  const { features } = context;
  const enabled = (item: { feature?: keyof BlueprintFeatures }): boolean =>
    item.feature === undefined || features[item.feature];

  const community = context.guildFeatures.includes('COMMUNITY');
  const roleIcons = context.guildFeatures.includes('ROLE_ICONS');
  const fallbacks: { key: string; message: string }[] = [];

  const departments = context.departments.filter((department) => department.space.enabled);
  const organizations = context.organizations;

  // Roles, top of the hierarchy first. Department and organisation roles sit
  // between staff and players, where their holders' rank reads naturally.
  const roles: DesiredRole[] = [
    ...staticRoles.filter(enabled),
    ...departments.flatMap((department): DesiredRole[] => {
      const label = departmentLabel(department);
      const color = colourFromHex(department.accentColour);
      const commandRole: DesiredRole = {
        key: `role.dept.${department.slug}.command`,
        name: `${label} Command`,
        color,
        hoist: false,
        mentionable: false,
        permissions: 0n,
        tier: 'department',
        selfAssignable: false,
        ...(department.space.commandRoleKey === undefined
          ? {}
          : { xenonRoleKey: department.space.commandRoleKey }),
      };
      const memberRole: DesiredRole = {
        key: `role.dept.${department.slug}.member`,
        name: label,
        color,
        hoist: true,
        mentionable: false,
        permissions: 0n,
        tier: 'department',
        selfAssignable: false,
        ...(department.roleKey === null ? {} : { xenonRoleKey: department.roleKey }),
      };
      return [commandRole, memberRole];
    }),
    ...organizations
      .filter((organization) => !organization.archived)
      .map((organization): DesiredRole => ({
        key: `role.org.${organization.key}`,
        name: organization.publicMembership
          ? organization.name
          : `Private Space ${codename(organization.key)}`,
        color: palette.none,
        hoist: false,
        mentionable: false,
        permissions: 0n,
        tier: 'organization',
        selfAssignable: false,
      })),
    ...playerRoles.filter(enabled),
  ].map((role) => {
    if (role.icon !== undefined && !roleIcons) {
      fallbacks.push({ key: role.key, message: 'Role icons need server boost level 2; skipped.' });
      const { icon: _icon, ...rest } = role;
      return rest;
    }
    return role;
  });

  const groups: Record<string, readonly string[]> = {
    management: roles.filter((role) => role.tier === 'management').map((role) => role.key),
    staff: roles
      .filter((role) => role.tier === 'management' || role.tier === 'staff')
      .map((role) => role.key),
  };

  const hasPublishedDepartments = context.departments.some((department) => department.published);

  const definitions: ChannelDef[] = [
    ...staticChannels.filter(enabled).filter((channel) => {
      if (channel.key === 'channel.departments') return hasPublishedDepartments;
      if (channel.key === 'channel.mod-alerts') return features.automod;
      return true;
    }),
    ...departments.flatMap(departmentChannels),
    ...organizations.flatMap(organizationChannels),
  ];

  // Temporary rooms are created by the bot under the voice category, so that
  // is the one place it holds Manage Channels - scoped, not guild-wide.
  const botManaged = new Set(features.tempVoice ? ['category.voice', 'voice.create-room'] : []);

  // A category nobody fills is not created. Order matters: city-info or
  // applications may be empty depending on features and departments.
  const withChildren = new Set(
    definitions.filter((channel) => channel.parent !== undefined).map((c) => c.parent),
  );
  const kept = definitions.filter(
    (channel) => channel.kind !== 'category' || withChildren.has(channel.key),
  );

  const byKey = new Map(kept.map((channel) => [channel.key, channel]));

  const channels = kept.map((definition): DesiredChannelState => {
    let effectiveKind = definition.kind;
    if ((definition.kind === 'announcement' || definition.kind === 'forum') && !community) {
      effectiveKind = 'text';
      fallbacks.push({
        key: definition.key,
        message: `${definition.kind === 'forum' ? 'Forum' : 'Announcement'} channels need Community enabled; created as a text channel instead.`,
      });
    }

    const policyName =
      definition.policy ??
      (definition.parent === undefined ? undefined : byKey.get(definition.parent)?.policy);
    if (policyName === undefined) {
      throw new Error(`Channel ${definition.key} has no policy and no category to inherit from`);
    }
    const policy = resolvePolicy(policyName);
    // An inheriting channel carries exactly its category's overwrites, i.e. it
    // is "synced" in Discord's terms. Computed from the category's kind so a
    // voice child of a mixed category gets the same bits Discord would copy.
    const inherits = definition.policy === undefined && definition.kind !== 'category';
    const overwriteKind = inherits ? 'category' : effectiveKind;

    return {
      ...definition,
      effectiveKind,
      inherits,
      visibility: policy.visibility,
      overwrites: buildOverwrites(policy, overwriteKind, groups, {
        botManages:
          botManaged.has(definition.key) ||
          (definition.parent !== undefined && inherits && botManaged.has(definition.parent)),
      }),
    };
  });

  const channelKeys = new Set(channels.map((channel) => channel.key));
  const panel = (key: string, kind: DesiredPanel['kind'], channel: string, live = false) =>
    channelKeys.has(channel) ? [{ key, kind, channel, live } satisfies DesiredPanel] : [];

  const panels: DesiredPanel[] = [
    ...panel('panel.welcome', 'welcome', 'channel.welcome'),
    ...panel('panel.support', 'support', 'channel.support'),
    ...panel('panel.rules', 'rules', 'channel.rules'),
    ...panel('panel.how-to-join', 'how-to-join', 'channel.how-to-join'),
    ...panel('panel.city-status', 'city-status', 'channel.city-status', true),
    ...panel('panel.choose-roles', 'choose-roles', 'channel.choose-roles'),
    ...panel('panel.applications', 'applications', 'channel.applications'),
    ...panel('panel.staff-review', 'staff', 'channel.whitelist-review'),
    ...panel('panel.departments', 'departments', 'channel.departments'),
    ...panel('panel.recruitment', 'department-recruitment', 'channel.recruitment'),
    ...departments.flatMap((department) =>
      panel(
        `panel.dept.${department.slug}.recruitment`,
        'department-recruitment',
        `channel.dept.${department.slug}.recruitment`,
      ).map((entry) => ({ ...entry, departmentSlug: department.slug })),
    ),
  ];

  const automod: DesiredAutoModRule[] = features.automod
    ? [
        {
          key: 'automod.mention-spam',
          name: 'Xenon · Mention spam',
          trigger: { type: 'mention-spam', limit: 6 },
          alertChannel: 'channel.mod-alerts',
          exemptRoles: groups.staff ?? [],
        },
        {
          key: 'automod.invites',
          name: 'Xenon · Invite links',
          trigger: {
            type: 'keyword',
            regex: ['(?:discord(?:app)?\\.com/invite|discord\\.gg)/[a-z0-9-]+'],
          },
          alertChannel: 'channel.mod-alerts',
          exemptRoles: groups.staff ?? [],
        },
        {
          key: 'automod.spam',
          name: 'Xenon · Suspected spam',
          trigger: { type: 'spam' },
          exemptRoles: groups.staff ?? [],
        },
      ]
    : [];

  return {
    version: BLUEPRINT_VERSION,
    roles,
    channels,
    panels,
    assets: context.assets,
    automod,
    fallbacks,
    manualSetup: manualSteps(community, roles),
    groups,
  };
}

/**
 * What the API cannot (safely) do, written as steps an operator can follow.
 *
 * Onboarding is here on purpose. The API can write it, but Discord validates
 * it against Community settings, default channels and prompt limits that vary
 * per guild, and a half-applied onboarding flow is worse than none.
 */
function manualSteps(community: boolean, roles: readonly DesiredRole[]): ManualStep[] {
  const steps: ManualStep[] = [];

  if (!community) {
    steps.push({
      key: 'manual.community',
      title: 'Enable Community (optional)',
      reason:
        'Announcement and forum channels, onboarding and the server guide need Community. Xenon created text-channel fallbacks meanwhile.',
      steps: [
        'Server Settings → Enable Community → Get Started.',
        'Rules or Guidelines channel: #rules. Community Updates channel: #bot-logs.',
        'Run /xenon setup plan again: fallbacks become announcement and forum channels only after an operator confirms the plan.',
      ],
    });
  }

  const notify = roles.filter((role) => role.tier === 'notification').map((role) => role.name);
  steps.push({
    key: 'manual.onboarding',
    title: 'Configure Discord onboarding',
    reason:
      'Discord validates onboarding against per-guild Community rules, so Xenon does not write it automatically.',
    steps: [
      'Server Settings → Onboarding → Set up.',
      'Default channels: #welcome, #rules, #how-to-join, #city-status, #announcements, #general, #choose-roles.',
      `Question "What would you like to follow?" (multiple): ${notify.join(', ')} - each option grants the matching role.`,
      'Question "What are you interested in?": Civilian Life, Emergency Services, Businesses, Community - channel suggestions only, no roles.',
      'Never offer criminal organisations or gangs as onboarding options.',
    ],
  });

  steps.push({
    key: 'manual.afk',
    title: 'Set the AFK channel',
    reason: 'A guild setting that needs Manage Server, which Xenon does not keep.',
    steps: ['Server Settings → Overview → Inactive Channel: AFK, timeout 15 minutes.'],
  });

  steps.push({
    key: 'manual.least-privilege',
    title: 'Return Xenon to least privilege',
    reason: 'Bootstrap permissions are only needed while applying the blueprint.',
    steps: [
      'Server Settings → Roles → Xenon: keep View Channels, Send Messages, Embed Links, Read Message History, Manage Roles.',
      'Remove Administrator, Manage Server, Manage Channels and Manage Expressions if they were granted for setup.',
      'Keep the Xenon role above every role it manages.',
    ],
  });

  return steps;
}

/** Every logical key the blueprint could ever produce for this context. */
export function desiredKeys(state: DesiredState): string[] {
  return [
    ...state.roles.map((role) => role.key),
    ...state.channels.map((channel) => channel.key),
    ...state.panels.map((panel) => panel.key),
    ...state.assets.map((asset) => asset.key),
    ...state.automod.map((rule) => rule.key),
  ];
}
