import { PermissionFlagsBits as P } from 'discord.js';

import type { Access, ChannelKind, Overwrite, PermissionPolicy, Visibility } from './types';

/**
 * The permission policy engine.
 *
 * Nothing else in the codebase writes a permission overwrite by hand. A channel
 * names a policy, a policy names audiences and access levels, and this module
 * turns that into bits for the channel's kind. Changing what "read-only" means
 * is one edit here rather than a hunt through forty channel definitions.
 */

const TEXT_READ = P.ViewChannel | P.ReadMessageHistory | P.AddReactions;
const TEXT_WRITE =
  TEXT_READ |
  P.SendMessages |
  P.SendMessagesInThreads |
  P.CreatePublicThreads |
  P.EmbedLinks |
  P.AttachFiles |
  P.UseExternalEmojis;
const TEXT_MODERATE = TEXT_WRITE | P.ManageMessages | P.ManageThreads;
/** What read-only removes from @everyone: posting in any form. */
const TEXT_POSTING =
  P.SendMessages | P.SendMessagesInThreads | P.CreatePublicThreads | P.CreatePrivateThreads;

const VOICE_READ = P.ViewChannel;
const VOICE_WRITE =
  VOICE_READ | P.Connect | P.Speak | P.Stream | P.UseVAD | P.SendMessages | P.ReadMessageHistory;
const VOICE_MODERATE = VOICE_WRITE | P.MuteMembers | P.DeafenMembers | P.MoveMembers;

/** The bot must always be able to read, post panels and embed in its channels. */
const BOT_BASE =
  P.ViewChannel |
  P.SendMessages |
  P.EmbedLinks |
  P.ReadMessageHistory |
  P.AttachFiles |
  P.UseExternalEmojis;
/** Only where temporary voice rooms live: scoped here instead of guild-wide. */
const BOT_MANAGES = P.ManageChannels | P.ManageRoles | P.MoveMembers | P.Connect;

type Kind = 'category' | ChannelKind;

function allowFor(access: Access, kind: Kind): bigint {
  const text = { read: TEXT_READ, write: TEXT_WRITE, moderate: TEXT_MODERATE }[access];
  const voice = { read: VOICE_READ, write: VOICE_WRITE, moderate: VOICE_MODERATE }[access];
  switch (kind) {
    case 'voice':
      return voice;
    // A category's overwrites flow to text and voice children alike.
    case 'category':
      return text | voice;
    case 'text':
    case 'announcement':
    case 'forum':
      return text;
  }
}

/** Bits a policy may grant at most. The bot must hold these to write overwrites. */
export const GRANTABLE_BITS =
  TEXT_MODERATE | VOICE_MODERATE | TEXT_POSTING | BOT_BASE | BOT_MANAGES;

const staffAccess = [
  { audience: 'group:staff', access: 'write' },
  { audience: 'group:management', access: 'moderate' },
] as const;

const publicScope: Visibility = { scope: 'public' };

const staticPolicies: Record<string, PermissionPolicy> = {
  PUBLIC_READ_ONLY: {
    name: 'PUBLIC_READ_ONLY',
    description: 'Everyone reads; management and the bot post.',
    everyone: 'read',
    grants: [{ audience: 'group:management', access: 'moderate' }],
    visibility: publicScope,
  },
  BOT_ONLY: {
    name: 'BOT_ONLY',
    description: 'Everyone reads; only Xenon posts.',
    everyone: 'read',
    grants: [],
    visibility: publicScope,
  },
  PUBLIC_CHAT: {
    name: 'PUBLIC_CHAT',
    description: 'Everyone talks; staff moderate.',
    everyone: 'write',
    grants: [{ audience: 'group:staff', access: 'moderate' }],
    visibility: publicScope,
  },
  WHITELISTED_CHAT: {
    name: 'WHITELISTED_CHAT',
    description: 'Only whitelisted citizens see and talk; staff moderate.',
    everyone: 'hidden',
    grants: [
      { audience: 'role.whitelisted', access: 'write' },
      { audience: 'group:staff', access: 'moderate' },
    ],
    visibility: { scope: 'public' },
  },
  STAFF_ONLY: {
    name: 'STAFF_ONLY',
    description: 'Hidden from everyone except staff.',
    everyone: 'hidden',
    grants: staffAccess,
    visibility: { scope: 'staff' },
  },
  STAFF_ANNOUNCE: {
    name: 'STAFF_ANNOUNCE',
    description: 'Staff read; management posts.',
    everyone: 'hidden',
    grants: [
      { audience: 'group:staff', access: 'read' },
      { audience: 'group:management', access: 'moderate' },
    ],
    visibility: { scope: 'staff' },
  },
  MANAGEMENT_ONLY: {
    name: 'MANAGEMENT_ONLY',
    description: 'Hidden from everyone except management.',
    everyone: 'hidden',
    grants: [{ audience: 'group:management', access: 'moderate' }],
    visibility: { scope: 'management' },
  },
  ARCHIVED: {
    name: 'ARCHIVED',
    description: 'History retained, read-only, visible to management only.',
    everyone: 'hidden',
    grants: [{ audience: 'group:management', access: 'read' }],
    visibility: { scope: 'management' },
  },
};

/**
 * Resolve a policy by name.
 *
 * Parameterised policies are `NAME:param`, so department and organisation
 * spaces stay data-driven: `DEPARTMENT_MEMBER:lspd` rather than a hardcoded
 * LSPD policy.
 */
export function resolvePolicy(name: string): PermissionPolicy {
  const fixed = staticPolicies[name];
  if (fixed !== undefined) return fixed;

  const [base = '', param] = name.split(':');
  if (param === undefined || param.length === 0) {
    throw new Error(`Unknown permission policy ${name}`);
  }

  const member = `role.dept.${param}.member`;
  const command = `role.dept.${param}.command`;

  switch (base) {
    case 'DEPARTMENT_MEMBER':
      return {
        name,
        description: `Department members of ${param}; command moderates.`,
        everyone: 'hidden',
        grants: [
          { audience: member, access: 'write' },
          { audience: command, access: 'moderate' },
          { audience: 'group:management', access: 'read' },
        ],
        visibility: { scope: 'department', slug: param },
      };
    case 'DEPARTMENT_ANNOUNCE':
      return {
        name,
        description: `Members of ${param} read; command posts.`,
        everyone: 'hidden',
        grants: [
          { audience: member, access: 'read' },
          { audience: command, access: 'moderate' },
          { audience: 'group:management', access: 'read' },
        ],
        visibility: { scope: 'department', slug: param },
      };
    case 'DEPARTMENT_COMMAND':
      return {
        name,
        description: `Command staff of ${param} only.`,
        everyone: 'hidden',
        grants: [
          { audience: command, access: 'moderate' },
          { audience: 'group:management', access: 'read' },
        ],
        visibility: { scope: 'department-command', slug: param },
      };
    case 'DEPARTMENT_PUBLIC':
      return {
        name,
        description: `Everyone reads; ${param} command posts.`,
        everyone: 'read',
        grants: [
          { audience: command, access: 'write' },
          { audience: 'group:management', access: 'moderate' },
        ],
        visibility: publicScope,
      };
    case 'ORGANIZATION_PRIVATE':
    case 'ORGANIZATION_PRIVATE_STAFF':
      return {
        name,
        description: `Members of organisation ${param} only.`,
        everyone: 'hidden',
        grants: [
          { audience: `role.org.${param}`, access: 'write' },
          ...(base === 'ORGANIZATION_PRIVATE_STAFF'
            ? [{ audience: 'group:management', access: 'read' } as const]
            : []),
        ],
        visibility: { scope: 'organization', key: param },
      };
    default:
      throw new Error(`Unknown permission policy ${name}`);
  }
}

export function policyNames(): readonly string[] {
  return Object.keys(staticPolicies);
}

/**
 * Build the overwrites a policy produces for a channel of one kind.
 *
 * Audiences stay logical here (`@everyone`, `bot`, `role.whitelisted`);
 * `resolveOverwrites` swaps them for snowflakes at plan time. Groups expand to
 * their member roles, and when two grants reach the same role the stronger one
 * wins because the bits are OR-ed.
 */
export function buildOverwrites(
  policy: PermissionPolicy,
  kind: Kind,
  groups: Readonly<Record<string, readonly string[]>>,
  options: { botManages?: boolean } = {},
): Overwrite[] {
  const byId = new Map<string, { allow: bigint; deny: bigint; type: 'role' | 'member' }>();

  const everyone =
    policy.everyone === 'hidden'
      ? { allow: 0n, deny: P.ViewChannel | P.Connect }
      : policy.everyone === 'read'
        ? {
            allow: allowFor('read', kind),
            deny: kind === 'voice' ? P.Connect : TEXT_POSTING,
          }
        : { allow: allowFor(policy.everyone, kind), deny: 0n };
  byId.set('@everyone', { ...everyone, type: 'role' });

  for (const grant of policy.grants) {
    const targets = grant.audience.startsWith('group:')
      ? (groups[grant.audience.slice('group:'.length)] ?? [])
      : [grant.audience];
    for (const target of targets) {
      const existing = byId.get(target);
      const allow = allowFor(grant.access, kind);
      byId.set(target, {
        type: 'role',
        allow: (existing?.allow ?? 0n) | allow,
        deny: 0n,
      });
    }
  }

  byId.set('bot', {
    type: 'member',
    allow: BOT_BASE | (options.botManages === true ? BOT_MANAGES : 0n),
    deny: 0n,
  });

  return [...byId.entries()]
    .map(([id, value]) => ({ id, ...value }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Swap logical audiences for snowflakes.
 *
 * An audience that cannot be resolved (a role skipped because of a conflict)
 * is dropped. That fails closed: a missing grant can only remove access, and
 * the @everyone and bot entries always resolve.
 */
export function resolveOverwrites(
  overwrites: readonly Overwrite[],
  resolve: (logical: string) => string | null,
): Overwrite[] {
  const resolved: Overwrite[] = [];
  for (const overwrite of overwrites) {
    const id = resolve(overwrite.id);
    if (id !== null) resolved.push({ ...overwrite, id });
  }
  return resolved.sort((a, b) => a.id.localeCompare(b.id));
}

/** Canonical text form, used for hashing and for comparing overwrite sets. */
export function overwriteSignature(overwrites: readonly Overwrite[]): string {
  return [...overwrites]
    .filter((overwrite) => overwrite.allow !== 0n || overwrite.deny !== 0n)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((o) => `${o.type}:${o.id}:${o.allow.toString()}:${o.deny.toString()}`)
    .join('|');
}

/** Human-readable permission names for a bitfield, for diffs and diagnostics. */
export function permissionNames(bits: bigint): string[] {
  const names: string[] = [];
  for (const [name, bit] of Object.entries(P)) {
    if ((bits & bit) === bit && bit !== 0n) names.push(name);
  }
  return names;
}
