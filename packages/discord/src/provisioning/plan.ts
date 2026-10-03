import { PermissionFlagsBits as P } from 'discord.js';

import { auditDesiredState, auditPermissions, type AuditResult } from './effective';
import { stableHash } from './hash';
import { GRANTABLE_BITS, overwriteSignature, permissionNames, resolveOverwrites } from './policies';

import type {
  ChangeKind,
  DesiredChannelState,
  DesiredRole,
  DesiredState,
  Diagnostic,
  FieldChange,
  GuildProfile,
  GuildSnapshot,
  Phase,
  Plan,
  PlanCounts,
  PlanItem,
  RegistryEntry,
  SnapshotChannel,
} from './types';

/**
 * The diff engine.
 *
 * DESIRED (blueprint + Xenon data) against ACTUAL (a guild snapshot), with the
 * registry deciding what Xenon owns. Pure and synchronous: the slash command,
 * the Control Center and the CLI all call this one function, so a plan cannot
 * differ depending on where it was asked for.
 *
 * Three rules shape every classification:
 *
 *  - Nothing is deleted. A managed resource that disappeared is DRIFT, and
 *    only an explicit repair recreates it.
 *  - Nothing unmanaged is taken over. A name collision is a CONFLICT the
 *    operator resolves (adopt, keep, alternative, manual).
 *  - Operators are not fought. Each resource remembers the hash of the
 *    configuration last applied; a difference with an unchanged hash is an
 *    operator's edit (DRIFT), a difference with a changed hash is a blueprint
 *    change (UPDATE).
 */

export interface PlanInput {
  readonly state: DesiredState;
  readonly snapshot: GuildSnapshot;
  readonly registry: readonly RegistryEntry[];
  /** Rendered content hash per non-live panel key. */
  readonly panelHashes: ReadonlyMap<string, string>;
  /** Existing Xenon role → Discord role mappings, to flag disagreements. */
  readonly roleMappings?: readonly {
    readonly xenonRoleKey: string;
    readonly discordRoleId: string;
  }[];
  readonly siteUrl?: string;
  readonly production?: boolean;
}

export interface PlanResult extends Plan {
  /** Desired-state audit: the blueprint itself must be safe before anything runs. */
  readonly blueprintAudit: AuditResult;
  /** Live audit of the managed channels as they are right now. */
  readonly liveAudit: AuditResult;
}

const MUTATING: ReadonlySet<ChangeKind> = new Set([
  'CREATE',
  'UPDATE',
  'MOVE',
  'PERMISSION_CHANGE',
]);

/** Channel kinds that can collide by name. */
function kindFamily(kind: SnapshotChannel['kind']): string {
  if (kind === 'category') return 'category';
  if (kind === 'voice') return 'voice';
  return 'text';
}

/** "🧭 Start Here" and "START HERE" are the same category to a human. */
export function normaliseName(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function roleStrict(role: DesiredRole) {
  return { permissions: role.permissions, mentionable: role.mentionable };
}
export function roleSoft(role: DesiredRole) {
  return { name: role.name, color: role.color, hoist: role.hoist };
}
/**
 * Hash of the strict configuration, counting only audiences that exist.
 *
 * A grant to a role that could not be created (an unresolved conflict) was
 * never applied, so it must not be part of what the registry remembers as
 * applied. When that role appears later, the hash moves and the channel shows
 * as a pending UPDATE rather than as an operator's drift.
 */
export function channelStrictHash(
  channel: DesiredChannelState,
  resolvable: (key: string) => boolean,
): string {
  return stableHash({
    parent: channel.parent ?? null,
    overwrites: overwriteSignature(
      channel.overwrites.filter((o) => o.id === '@everyone' || o.id === 'bot' || resolvable(o.id)),
    ),
    kind: channel.effectiveKind,
  });
}
export function channelSoft(channel: DesiredChannelState) {
  return {
    name: channel.name,
    topic: channel.topic ?? null,
    slowmode: channel.slowmodeSeconds ?? 0,
    userLimit: channel.userLimit ?? 0,
  };
}

/** Discord's per-tier limits, applied to the tier the guild actually has. */
export function assetCapacity(snapshot: GuildSnapshot): {
  staticEmoji: number;
  animatedEmoji: number;
  stickers: number;
} {
  const emoji = [50, 100, 150, 250][snapshot.premiumTier] ?? 50;
  const stickers = [5, 15, 30, 60][snapshot.premiumTier] ?? 5;
  return {
    staticEmoji: emoji - snapshot.emojis.filter((e) => !e.animated).length,
    animatedEmoji: emoji - snapshot.emojis.filter((e) => e.animated).length,
    stickers: stickers - snapshot.stickers.length,
  };
}

function isLocalhost(url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

export function planGuild(input: PlanInput): PlanResult {
  const { state, snapshot } = input;
  const registry = new Map(input.registry.map((entry) => [entry.logicalKey, entry]));
  const items: PlanItem[] = [];
  const diagnostics: Diagnostic[] = [];

  const rolesById = new Map(snapshot.roles.map((role) => [role.id, role]));
  const channelsById = new Map(snapshot.channels.map((channel) => [channel.id, channel]));

  /**
   * Snowflake for a logical key, only while it still exists: an overwrite that
   * points at a deleted role is rejected by Discord, and a parent that no
   * longer exists cannot hold a channel.
   */
  const idOf = (key: string): string | null => {
    if (key === '@everyone') return snapshot.id;
    if (key === 'bot') return snapshot.bot.userId;
    const entry = registry.get(key);
    const id = entry?.discordId ?? null;
    if (entry === undefined || id === null) return null;
    if (entry.resourceType === 'ROLE') return rolesById.has(id) ? id : null;
    if (entry.resourceType === 'CHANNEL' || entry.resourceType === 'CATEGORY') {
      return channelsById.has(id) ? id : null;
    }
    return id;
  };

  const push = (item: Omit<PlanItem, 'changes'> & { changes?: FieldChange[] }) => {
    items.push({ changes: [], ...item });
  };

  // --- Roles ------------------------------------------------------------------

  const claimedRoleIds = new Set(
    input.registry.filter((entry) => entry.resourceType === 'ROLE').map((entry) => entry.discordId),
  );
  const roleOutcome = new Map<string, ChangeKind>();

  for (const role of state.roles) {
    const entry = registry.get(role.key);
    const label = `@${role.name}`;
    const base = { key: role.key, resourceType: 'ROLE' as const, phase: 'ROLES' as const, label };

    if (entry !== undefined && !entry.managed) {
      push({
        ...base,
        kind: 'UNCHANGED',
        summary: 'Left unmanaged by operator decision',
        discordId: entry.discordId,
      });
      roleOutcome.set(role.key, 'UNCHANGED');
      continue;
    }

    const actual = entry?.discordId == null ? undefined : rolesById.get(entry.discordId);

    if (entry?.discordId != null && actual === undefined) {
      push({
        ...base,
        kind: 'DRIFT',
        summary: 'Managed role was deleted in Discord',
        discordId: entry.discordId,
        strictDrift: true,
      });
      roleOutcome.set(role.key, 'DRIFT');
      continue;
    }

    if (actual !== undefined && entry !== undefined) {
      if (actual.position >= snapshot.bot.highestRolePosition) {
        diagnostics.push({
          code: 'ROLE_ABOVE_BOT',
          severity: 'error',
          message: `${label} sits at or above the Xenon role and cannot be managed.`,
          key: role.key,
        });
      }

      const strict: FieldChange[] = [];
      if (actual.permissions !== role.permissions) {
        strict.push({
          field: 'permissions',
          from: permissionNames(actual.permissions).join(', ') || 'none',
          to: permissionNames(role.permissions).join(', ') || 'none',
          strict: true,
        });
      }
      if (actual.mentionable !== role.mentionable) {
        strict.push({
          field: 'mentionable',
          from: String(actual.mentionable),
          to: String(role.mentionable),
          strict: true,
        });
      }
      const soft: FieldChange[] = [];
      if (actual.name !== role.name)
        soft.push({ field: 'name', from: actual.name, to: role.name, strict: false });
      if (actual.color !== role.color) {
        soft.push({ field: 'color', from: hex(actual.color), to: hex(role.color), strict: false });
      }
      if (actual.hoist !== role.hoist)
        soft.push({
          field: 'hoist',
          from: String(actual.hoist),
          to: String(role.hoist),
          strict: false,
        });

      const kind = classify(
        entry,
        stableHash(roleStrict(role)),
        stableHash(roleSoft(role)),
        strict,
        soft,
      );
      const blocked =
        actual.position >= snapshot.bot.highestRolePosition && MUTATING.has(kind.kind);
      push({
        ...base,
        kind: blocked ? 'MANUAL_REVIEW' : kind.kind,
        summary: blocked ? 'Role is above the Xenon role; move Xenon higher first' : kind.summary,
        changes: kind.changes,
        discordId: actual.id,
        strictDrift: kind.strictDrift,
        ...(blocked ? { blockedBy: 'BOT_ROLE_TOO_LOW' } : {}),
      });
      roleOutcome.set(role.key, blocked ? 'MANUAL_REVIEW' : kind.kind);
      continue;
    }

    const name =
      typeof entry?.metadata.alternativeName === 'string'
        ? entry.metadata.alternativeName
        : role.name;
    const sameName = snapshot.roles.filter(
      (candidate) =>
        !candidate.managed &&
        !claimedRoleIds.has(candidate.id) &&
        normaliseName(candidate.name) === normaliseName(name),
    );
    if (sameName.length > 1) {
      diagnostics.push({
        code: 'DUPLICATE_ROLE',
        severity: 'warning',
        message: `${String(sameName.length)} unmanaged roles are named ${role.name}.`,
        key: role.key,
      });
    }
    const existing = sameName[0];
    if (existing !== undefined) {
      push({
        ...base,
        kind: 'CONFLICT',
        summary: `@${existing.name} already exists but is not managed by Xenon`,
        discordId: null,
        conflict: { id: existing.id, name: existing.name },
      });
      roleOutcome.set(role.key, 'CONFLICT');
      continue;
    }

    push({
      ...base,
      kind: 'CREATE',
      summary: `Create ${label === `@${name}` ? label : `@${name}`}`,
      discordId: null,
    });
    roleOutcome.set(role.key, 'CREATE');
  }

  // Hierarchy: new roles land at the bottom, so ordering runs whenever a role
  // is created. Otherwise a wrong order is an operator's arrangement and is
  // reported, not corrected.
  const ordered = state.roles
    .map((role) => idOf(role.key))
    .map((id) => (id === null ? undefined : rolesById.get(id)))
    .filter((role) => role !== undefined);
  const outOfOrder = ordered.some(
    (role, index) => index > 0 && (ordered[index - 1]?.position ?? 0) <= role.position,
  );
  const creatingRoles = [...roleOutcome.values()].includes('CREATE');
  if (creatingRoles || outOfOrder) {
    push({
      key: 'hierarchy.roles',
      resourceType: 'ROLE',
      phase: 'ROLES',
      label: 'Role hierarchy',
      kind: creatingRoles ? 'MOVE' : 'DRIFT',
      summary: creatingRoles
        ? 'Order Xenon roles below the Xenon bot role, in blueprint order'
        : 'Xenon roles are not in blueprint order',
      discordId: null,
      strictDrift: false,
    });
  }

  for (const mapping of input.roleMappings ?? []) {
    const role = state.roles.find((candidate) => candidate.xenonRoleKey === mapping.xenonRoleKey);
    const id = role === undefined ? null : idOf(role.key);
    if (role !== undefined && id !== null && id !== mapping.discordRoleId) {
      diagnostics.push({
        code: 'ROLE_MAPPING_CONFLICT',
        severity: 'warning',
        message: `Xenon role "${mapping.xenonRoleKey}" is already mapped to another Discord role; ${role.name} will not replace it automatically.`,
        key: role.key,
      });
    }
  }

  const managedRoleIds = new Set(
    input.registry.flatMap((entry) =>
      entry.resourceType === 'ROLE' && entry.discordId !== null ? [entry.discordId] : [],
    ),
  );
  const unmanagedRoles = snapshot.roles.filter(
    (role) => role.id !== snapshot.id && !role.managed && !managedRoleIds.has(role.id),
  );
  if (unmanagedRoles.length > 0) {
    diagnostics.push({
      code: 'UNMANAGED_ROLE',
      severity: 'info',
      message: `${String(unmanagedRoles.length)} roles are not part of the blueprint and are left untouched.`,
    });
  }

  // --- Channels ----------------------------------------------------------------

  const claimedChannelIds = new Set(
    input.registry
      .filter((entry) => entry.resourceType === 'CHANNEL' || entry.resourceType === 'CATEGORY')
      .map((entry) => entry.discordId),
  );
  const channelOutcome = new Map<string, ChangeKind>();

  for (const channel of state.channels) {
    const resourceType = channel.kind === 'category' ? ('CATEGORY' as const) : ('CHANNEL' as const);
    const phase: Phase = channel.kind === 'category' ? 'CATEGORIES' : 'CHANNELS';
    const label =
      channel.kind === 'category'
        ? channel.name
        : channel.kind === 'voice'
          ? `🔊 ${channel.name}`
          : `#${channel.name}`;
    const base = { key: channel.key, resourceType, phase, label };
    const entry = registry.get(channel.key);

    const parentOutcome =
      channel.parent === undefined ? undefined : channelOutcome.get(channel.parent);
    const parentBlocked =
      parentOutcome === 'CONFLICT' ||
      parentOutcome === 'MANUAL_REVIEW' ||
      (parentOutcome === 'DRIFT' && idOf(channel.parent ?? '') === null);

    if (entry !== undefined && !entry.managed) {
      push({
        ...base,
        kind: 'UNCHANGED',
        summary: 'Left unmanaged by operator decision',
        discordId: entry.discordId,
      });
      channelOutcome.set(channel.key, 'UNCHANGED');
      continue;
    }

    const actual = entry?.discordId == null ? undefined : channelsById.get(entry.discordId);
    if (entry?.discordId != null && actual === undefined) {
      push({
        ...base,
        kind: 'DRIFT',
        summary: 'Managed channel was deleted in Discord',
        discordId: entry.discordId,
        strictDrift: true,
      });
      channelOutcome.set(channel.key, 'DRIFT');
      continue;
    }

    if (actual !== undefined && entry !== undefined) {
      if (actual.kind !== channel.effectiveKind) {
        push({
          ...base,
          kind: 'MANUAL_REVIEW',
          summary: `Exists as ${actual.kind}; the blueprint now wants ${channel.effectiveKind}. Convert or recreate it by hand to keep its history.`,
          discordId: actual.id,
        });
        channelOutcome.set(channel.key, 'MANUAL_REVIEW');
        continue;
      }

      const strict: FieldChange[] = [];
      const wantParent = channel.parent === undefined ? null : idOf(channel.parent);
      if (channel.parent !== undefined && wantParent !== null && actual.parentId !== wantParent) {
        strict.push({
          field: 'category',
          from:
            actual.parentId === null
              ? 'none'
              : (channelsById.get(actual.parentId)?.name ?? actual.parentId),
          to:
            state.channels.find((candidate) => candidate.key === channel.parent)?.name ??
            channel.parent,
          strict: true,
        });
      }
      const wantOverwrites = resolveOverwrites(channel.overwrites, idOf);
      const pendingGrant = channel.overwrites.some((o) => roleOutcome.get(o.id) === 'CREATE');
      if (
        pendingGrant ||
        overwriteSignature(wantOverwrites) !==
          overwriteSignature(
            managedSlice(actual.overwrites, snapshot.id, managedRoleIds, snapshot.bot.userId),
          )
      ) {
        strict.push({
          field: 'permissions',
          from: 'custom',
          to: `${String(wantOverwrites.length)} policy overwrites`,
          strict: true,
        });
      }

      const soft: FieldChange[] = [];
      if (actual.name !== channel.name)
        soft.push({ field: 'name', from: actual.name, to: channel.name, strict: false });
      if (
        channel.kind !== 'category' &&
        channel.kind !== 'voice' &&
        (actual.topic ?? '') !== (channel.topic ?? '')
      ) {
        soft.push({
          field: 'topic',
          from: actual.topic ?? '',
          to: channel.topic ?? '',
          strict: false,
        });
      }
      if (
        (actual.slowmodeSeconds ?? 0) !== (channel.slowmodeSeconds ?? 0) &&
        channel.effectiveKind === 'text'
      ) {
        soft.push({
          field: 'slowmode',
          from: String(actual.slowmodeSeconds ?? 0),
          to: String(channel.slowmodeSeconds ?? 0),
          strict: false,
        });
      }
      if (channel.kind === 'voice' && (actual.userLimit ?? 0) !== (channel.userLimit ?? 0)) {
        soft.push({
          field: 'user limit',
          from: String(actual.userLimit ?? 0),
          to: String(channel.userLimit ?? 0),
          strict: false,
        });
      }

      const resolvable = (key: string) => idOf(key) !== null || roleOutcome.get(key) === 'CREATE';
      const outcome = classify(
        entry,
        channelStrictHash(channel, resolvable),
        stableHash(channelSoft(channel)),
        strict,
        soft,
      );
      const onlyPermissions =
        outcome.kind === 'UPDATE' &&
        outcome.changes.every((change) => change.field === 'permissions');
      push({
        ...base,
        kind: onlyPermissions ? 'PERMISSION_CHANGE' : outcome.kind,
        phase: onlyPermissions ? 'PERMISSIONS' : phase,
        summary: onlyPermissions ? `Apply ${policyOf(channel)} policy` : outcome.summary,
        changes: outcome.changes,
        discordId: actual.id,
        strictDrift: outcome.strictDrift,
      });
      channelOutcome.set(channel.key, outcome.kind);
      continue;
    }

    if (parentBlocked) {
      push({
        ...base,
        kind: 'MANUAL_REVIEW',
        summary: 'Waiting on its category, which needs an operator decision',
        discordId: null,
        blockedBy: channel.parent,
      });
      channelOutcome.set(channel.key, 'MANUAL_REVIEW');
      continue;
    }

    const name =
      typeof entry?.metadata.alternativeName === 'string'
        ? entry.metadata.alternativeName
        : channel.name;
    // Channels inside a department or organisation space share generic names
    // (#general) with the rest of the server, so they only collide within
    // their own category; everything else collides server-wide.
    const scoped = /^(channel|voice)\.(dept|org)\./.test(channel.key);
    const parentId = channel.parent === undefined ? null : idOf(channel.parent);
    const existing = snapshot.channels.find(
      (candidate) =>
        !claimedChannelIds.has(candidate.id) &&
        kindFamily(candidate.kind) === kindFamily(channel.effectiveKind) &&
        normaliseName(candidate.name) === normaliseName(name) &&
        (!scoped || (parentId !== null && candidate.parentId === parentId)),
    );
    if (existing !== undefined && !(scoped && parentId === null)) {
      push({
        ...base,
        kind: 'CONFLICT',
        summary: `${channel.kind === 'category' ? existing.name : `#${existing.name}`} already exists but is unmanaged`,
        discordId: null,
        conflict: { id: existing.id, name: existing.name },
      });
      channelOutcome.set(channel.key, 'CONFLICT');
      continue;
    }

    push({
      ...base,
      kind: 'CREATE',
      summary: `Create ${channel.effectiveKind} ${label} (${policyOf(channel)})`,
      discordId: null,
    });
    channelOutcome.set(channel.key, 'CREATE');
  }

  // --- Assets ------------------------------------------------------------------

  const capacity = assetCapacity(snapshot);
  const emojiByName = new Map(snapshot.emojis.map((emoji) => [emoji.name, emoji]));
  const emojiById = new Map(snapshot.emojis.map((emoji) => [emoji.id, emoji]));
  const stickerById = new Map(snapshot.stickers.map((sticker) => [sticker.id, sticker]));
  const stickerByName = new Map(snapshot.stickers.map((sticker) => [sticker.name, sticker]));

  const rankedAssets = [...state.assets].sort(
    (a, b) =>
      Number(b.required) - Number(a.required) ||
      a.priority - b.priority ||
      a.key.localeCompare(b.key),
  );
  for (const asset of rankedAssets) {
    const entry = registry.get(asset.key);
    const base = {
      key: asset.key,
      resourceType: asset.type,
      phase: 'ASSETS' as const,
      label: asset.type === 'EMOJI' ? `:${asset.name}:` : `Sticker ${asset.name}`,
    };
    if (entry !== undefined && !entry.managed) {
      push({
        ...base,
        kind: 'UNCHANGED',
        summary: 'Left unmanaged by operator decision',
        discordId: entry.discordId,
      });
      continue;
    }
    const exists =
      entry?.discordId != null &&
      (asset.type === 'EMOJI' ? emojiById.has(entry.discordId) : stickerById.has(entry.discordId));

    if (entry?.discordId != null && !exists) {
      // Replaced with another image under the same name shows up here too:
      // Discord cannot change an emoji's image in place, so a replacement is a
      // new snowflake and the one Xenon recorded is gone.
      const replaced = asset.type === 'EMOJI' && emojiByName.has(asset.name);
      push({
        ...base,
        kind: replaced ? 'MANUAL_REVIEW' : 'DRIFT',
        summary: replaced
          ? `:${asset.name}: was replaced by a different emoji outside Xenon`
          : 'Managed asset was removed in Discord',
        discordId: entry.discordId,
        strictDrift: true,
      });
      continue;
    }
    if (exists) {
      push(
        entry.contentHash === asset.hash
          ? {
              ...base,
              kind: 'UNCHANGED',
              summary: 'Uploaded and unchanged',
              discordId: entry.discordId,
            }
          : {
              ...base,
              kind: 'MANUAL_REVIEW',
              summary:
                'Source image changed; replacing it means removing the uploaded one (pnpm discord:assets:sync --replace)',
              discordId: entry.discordId,
            },
      );
      continue;
    }

    const clash =
      asset.type === 'EMOJI' ? emojiByName.get(asset.name) : stickerByName.get(asset.name);
    if (clash !== undefined) {
      push({
        ...base,
        kind: 'CONFLICT',
        summary: `${asset.type === 'EMOJI' ? `:${asset.name}:` : asset.name} already exists and is not Xenon's`,
        discordId: null,
        conflict: { id: clash.id, name: clash.name },
      });
      continue;
    }

    const slot: keyof typeof capacity =
      asset.type === 'STICKER' ? 'stickers' : asset.animated ? 'animatedEmoji' : 'staticEmoji';
    if (capacity[slot] <= 0) {
      push({
        ...base,
        kind: 'CAPACITY_BLOCKED',
        summary: 'No free slot at the current server boost level',
        discordId: null,
      });
      continue;
    }
    capacity[slot] -= 1;
    push({ ...base, kind: 'CREATE', summary: `Upload ${base.label}`, discordId: null });
  }
  const blockedAssets = items.filter((item) => item.kind === 'CAPACITY_BLOCKED').length;
  if (blockedAssets > 0) {
    diagnostics.push({
      code: 'CAPACITY_BLOCKED',
      severity: 'warning',
      message: `${String(blockedAssets)} assets do not fit the server's current capacity; required and higher-priority assets were kept.`,
    });
  }

  // --- Panels ------------------------------------------------------------------

  for (const panel of state.panels) {
    const entry = registry.get(panel.key);
    const channelOutcomeKind = channelOutcome.get(panel.channel);
    const channelId = idOf(panel.channel);
    const base = {
      key: panel.key,
      resourceType: 'PANEL' as const,
      phase: 'PANELS' as const,
      label: `${panel.kind} panel`,
    };

    const present =
      entry?.discordId != null &&
      entry.channelId !== null &&
      entry.channelId === channelId &&
      snapshot.panelMessages.has(`${entry.channelId}:${entry.discordId}`);

    if (entry?.discordId != null && !present) {
      push({
        ...base,
        kind: 'DRIFT',
        summary: 'Panel message was deleted or its channel replaced',
        discordId: entry.discordId,
        strictDrift: true,
      });
      continue;
    }
    if (present) {
      const hash = input.panelHashes.get(panel.key);
      push(
        panel.live || hash === undefined || hash === entry.contentHash
          ? {
              ...base,
              kind: 'UNCHANGED',
              summary: panel.live ? 'Live panel, refreshed by the bot' : 'Up to date',
              discordId: entry.discordId,
            }
          : {
              ...base,
              kind: 'UPDATE',
              summary: 'Content changed; edit in place',
              discordId: entry.discordId,
            },
      );
      continue;
    }
    if (channelId === null && channelOutcomeKind !== 'CREATE') {
      push({
        ...base,
        kind: 'MANUAL_REVIEW',
        summary: 'Its channel is not available yet',
        discordId: null,
        blockedBy: panel.channel,
      });
      continue;
    }
    push({ ...base, kind: 'CREATE', summary: `Post the ${panel.kind} panel`, discordId: null });
  }

  // --- AutoMod -----------------------------------------------------------------

  const automodById = new Map(snapshot.automodRules.map((rule) => [rule.id, rule]));
  for (const rule of state.automod) {
    const entry = registry.get(rule.key);
    const base = {
      key: rule.key,
      resourceType: 'AUTOMOD' as const,
      phase: 'AUTOMOD' as const,
      label: rule.name,
    };
    if (entry?.discordId != null) {
      const actual = automodById.get(entry.discordId);
      if (actual === undefined) {
        push({
          ...base,
          kind: 'DRIFT',
          summary: 'AutoMod rule was deleted',
          discordId: entry.discordId,
          strictDrift: false,
        });
      } else if (!actual.enabled) {
        push({
          ...base,
          kind: 'DRIFT',
          summary: 'AutoMod rule was disabled in Discord',
          discordId: actual.id,
          strictDrift: false,
        });
      } else {
        push({
          ...base,
          kind: entry.configurationHash === stableHash(rule) ? 'UNCHANGED' : 'UPDATE',
          summary: 'AutoMod rule',
          discordId: actual.id,
        });
      }
      continue;
    }
    const clash = snapshot.automodRules.find((candidate) => candidate.name === rule.name);
    push(
      clash === undefined
        ? {
            ...base,
            kind: 'CREATE',
            summary: `Create AutoMod rule (block + alert, never ban)`,
            discordId: null,
          }
        : {
            ...base,
            kind: 'CONFLICT',
            summary: 'A rule with this name exists',
            discordId: null,
            conflict: { id: clash.id, name: clash.name },
          },
    );
  }

  // --- Capabilities and permissions --------------------------------------------

  for (const fallback of state.fallbacks) {
    diagnostics.push({
      code: 'CAPABILITY_FALLBACK',
      severity: 'info',
      message: fallback.message,
      key: fallback.key,
    });
  }

  const hasAdmin = (snapshot.bot.permissions & P.Administrator) === P.Administrator;
  if (!hasAdmin && (snapshot.bot.permissions & P.ManageRoles) === 0n) {
    diagnostics.push({
      code: 'MISSING_MANAGE_ROLES',
      severity: 'error',
      message:
        'Xenon is missing Manage Roles, which it needs to create roles, write channel permissions and sync members.',
    });
  }

  const pending = items.filter((item) => MUTATING.has(item.kind) || item.kind === 'DRIFT');
  const needed =
    (pending.some(
      (item) =>
        item.phase === 'CATEGORIES' || item.phase === 'CHANNELS' || item.phase === 'PERMISSIONS',
    )
      ? P.ManageChannels | P.ManageRoles | GRANTABLE_BITS
      : 0n) |
    (pending.some((item) => item.phase === 'ROLES')
      ? P.ManageRoles | state.roles.reduce((bits, role) => bits | role.permissions, 0n)
      : 0n) |
    (pending.some((item) => item.phase === 'ASSETS') ? P.ManageGuildExpressions : 0n) |
    (pending.some((item) => item.phase === 'AUTOMOD') ? P.ManageGuild : 0n) |
    (pending.some((item) => item.phase === 'PANELS') ? P.SendMessages | P.EmbedLinks : 0n);
  const missing = hasAdmin ? 0n : needed & ~snapshot.bot.permissions;
  if (missing !== 0n) {
    diagnostics.push({
      code: 'MISSING_BOOTSTRAP_PERMISSION',
      severity: 'error',
      message: `To apply this plan Xenon temporarily needs: ${permissionNames(missing).join(', ')}. Discord only lets a bot grant permissions it holds itself. Remove them again after setup.`,
    });
  }

  if (input.production === true && isLocalhost(input.siteUrl)) {
    diagnostics.push({
      code: 'LOCALHOST_LINK',
      severity: 'error',
      message:
        'NEXT_PUBLIC_SITE_URL points at localhost in production; panel buttons would link nowhere and are omitted.',
    });
  }

  const blueprintAudit = auditDesiredState(state);
  const liveAudit = auditLive(state, snapshot, idOf, managedRoleIds);
  diagnostics.push(
    ...blueprintAudit.diagnostics,
    ...liveAudit.diagnostics.filter((d) => d.severity !== 'info'),
  );

  const counts = countItems(items);
  const nonTrivialRoles = snapshot.roles.filter(
    (role) => role.id !== snapshot.id && !role.managed,
  ).length;
  const profile: GuildProfile = input.registry.some((entry) => entry.discordId !== null)
    ? 'MANAGED'
    : nonTrivialRoles <= 3 && snapshot.channels.length <= 8
      ? 'EMPTY'
      : 'ESTABLISHED';

  return {
    version: state.version,
    guildId: snapshot.id,
    guildName: snapshot.name,
    generatedAt: new Date().toISOString(),
    profile,
    items,
    diagnostics: dedupe(diagnostics),
    manualSetup: state.manualSetup,
    counts,
    signature: planSignature(items),
    blueprintAudit,
    liveAudit,
  };
}

/** Sorted `key:kind` of mutating and drift items. An approval approves exactly this. */
export function planSignature(items: readonly PlanItem[]): string[] {
  return items
    .filter((item) => MUTATING.has(item.kind) || item.kind === 'DRIFT')
    .map((item) => `${item.key}:${item.kind}`)
    .sort();
}

/**
 * Items a fresh plan wants to execute that the approved plan did not contain.
 * Non-empty means the guild changed since approval and the operator must look
 * again rather than approve something they never saw.
 */
export function unapprovedChanges(fresh: readonly string[], approved: readonly string[]): string[] {
  const allowed = new Set(approved);
  return fresh.filter((entry) => !allowed.has(entry));
}

export function countItems(items: readonly PlanItem[]): PlanCounts {
  const count = (kind: ChangeKind) => items.filter((item) => item.kind === kind).length;
  return {
    create: count('CREATE'),
    update: count('UPDATE'),
    move: count('MOVE'),
    permission: count('PERMISSION_CHANGE'),
    unchanged: count('UNCHANGED'),
    drift: count('DRIFT'),
    conflict: count('CONFLICT'),
    manual: count('MANUAL_REVIEW'),
    capacity: count('CAPACITY_BLOCKED'),
  };
}

function classify(
  entry: RegistryEntry,
  strictHash: string,
  softHash: string,
  strict: FieldChange[],
  soft: FieldChange[],
): { kind: ChangeKind; summary: string; changes: FieldChange[]; strictDrift: boolean } {
  const appliedStrict = entry.metadata.strictHash;
  const appliedSoft = entry.metadata.softHash;
  // A group whose desired hash moved is a blueprint change; otherwise the
  // difference was made in Discord by a person.
  const strictIsUpdate = appliedStrict !== strictHash;
  const softIsUpdate = appliedSoft !== softHash;

  const updates = [...(strictIsUpdate ? strict : []), ...(softIsUpdate ? soft : [])];
  const drift = [...(strictIsUpdate ? [] : strict), ...(softIsUpdate ? [] : soft)];

  if (updates.length > 0) {
    return {
      kind: 'UPDATE',
      summary: updates.map((c) => c.field).join(', '),
      changes: [...updates, ...drift],
      strictDrift: drift.some((c) => c.strict),
    };
  }
  if (drift.length > 0) {
    const strictDrift = drift.some((change) => change.strict);
    return {
      kind: 'DRIFT',
      summary: `${strictDrift ? 'Changed' : 'Customised'} in Discord: ${drift.map((c) => c.field).join(', ')}`,
      changes: drift,
      strictDrift,
    };
  }
  return { kind: 'UNCHANGED', summary: 'Matches the blueprint', changes: [], strictDrift: false };
}

/**
 * The overwrites on a channel that Xenon is responsible for.
 *
 * An operator's extra overwrite for a role Xenon does not manage is theirs to
 * keep; it is audited for leaks, not treated as drift to be erased.
 */
function managedSlice(
  actual: SnapshotChannel['overwrites'],
  everyoneId: string,
  managedRoleIds: ReadonlySet<string>,
  botUserId: string,
) {
  return actual.filter(
    (overwrite) =>
      overwrite.id === everyoneId ||
      overwrite.id === botUserId ||
      (overwrite.type === 'role' && managedRoleIds.has(overwrite.id)),
  );
}

function auditLive(
  state: DesiredState,
  snapshot: GuildSnapshot,
  idOf: (key: string) => string | null,
  managedRoleIds: ReadonlySet<string>,
): AuditResult {
  const byId = new Map(snapshot.channels.map((channel) => [channel.id, channel]));
  const channels = state.channels.flatMap((channel) => {
    const id = idOf(channel.key);
    const actual = id === null ? undefined : byId.get(id);
    return actual === undefined
      ? []
      : [
          {
            key: channel.key,
            label: actual.kind === 'category' ? actual.name : `#${actual.name}`,
            overwrites: actual.overwrites,
            visibility: channel.visibility,
          },
        ];
  });
  return auditPermissions({
    state,
    model: {
      everyoneId: snapshot.id,
      rolePermissions: new Map(snapshot.roles.map((role) => [role.id, role.permissions])),
    },
    channels,
    resolve: idOf,
    botMemberId: snapshot.bot.userId,
    botRoleIds: snapshot.bot.roleIds,
    managedRoleIds,
  });
}

function policyOf(channel: DesiredChannelState): string {
  return channel.policy ?? 'inherited';
}

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0').toUpperCase()}`;
}

function dedupe(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const id = `${diagnostic.code}|${diagnostic.key ?? ''}|${diagnostic.message}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
