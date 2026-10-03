import { stableHash } from './hash';
import { panelHash } from './panels';
import { channelSoft, channelStrictHash, roleSoft, roleStrict } from './plan';
import { resolveOverwrites } from './policies';

import type { EmojiRef, PanelPayload } from './panels';
import type { GuildAdapter, RegistryStore } from './ports';
import type {
  DesiredAsset,
  DesiredChannelState,
  DesiredPanel,
  DesiredRole,
  DesiredState,
  GuildSnapshot,
  Phase,
  PlanItem,
  RegistryEntry,
  ResourceType,
} from './types';

/**
 * The executor.
 *
 * Walks a fresh plan phase by phase - roles, categories, channels,
 * permissions, assets, panels, AutoMod - and records every success in the
 * registry the moment Discord confirms it. That write-as-you-go is the whole
 * of resumability: a run that dies halfway leaves a registry describing
 * exactly what exists, and the next plan simply finds less to do.
 *
 * Operations run one at a time with a small pause between them. discord.js
 * already honours per-route rate limits; pacing keeps a large first apply from
 * burning through the global bucket and starving the rest of the bot.
 */

export type ExecutionMode = 'apply' | 'repair';

export interface PhaseProgress {
  readonly done: number;
  readonly total: number;
}

export type Progress = Record<Phase, PhaseProgress> & { current: string | null };

export interface ExecuteOptions {
  readonly mode: ExecutionMode;
  readonly runId: string;
  readonly blueprintVersion: string;
  /** Repair soft drift (names, topics, order) as well as strict drift. */
  readonly includeSoft?: boolean;
  /** Restrict execution to these keys (ENFORCE uses the critical set). */
  readonly onlyKeys?: ReadonlySet<string>;
  readonly pacingMs?: number;
  readonly maxConsecutiveFailures?: number;
  readonly renderPanel: (
    panel: DesiredPanel,
    emojis: ReadonlyMap<string, EmojiRef>,
  ) => PanelPayload;
  readonly readAsset: (asset: DesiredAsset) => Promise<Buffer>;
  readonly onProgress?: (progress: Progress) => void | Promise<void>;
}

export interface AppliedChange {
  readonly key: string;
  readonly kind: PlanItem['kind'];
  readonly action: string;
  readonly discordId: string | null;
  readonly resourceType: ResourceType;
}

export interface ExecutionResult {
  readonly applied: readonly AppliedChange[];
  readonly failed: readonly { readonly key: string; readonly message: string }[];
  readonly skipped: readonly { readonly key: string; readonly reason: string }[];
  readonly aborted: boolean;
  /** Logical key → snowflake after execution. */
  readonly ids: ReadonlyMap<string, string>;
}

const PHASES: readonly Phase[] = [
  'ROLES',
  'CATEGORIES',
  'CHANNELS',
  'PERMISSIONS',
  'ASSETS',
  'PANELS',
  'AUTOMOD',
];
const MUTATING = new Set(['CREATE', 'UPDATE', 'MOVE', 'PERMISSION_CHANGE']);

/** Discord error codes that mean "this server is full", not "try again". */
const CAPACITY_CODES = new Set([30008, 30039]);

export function selectExecutable(
  items: readonly PlanItem[],
  options: Pick<ExecuteOptions, 'mode' | 'includeSoft' | 'onlyKeys'>,
): PlanItem[] {
  return items.filter((item) => {
    if (item.blockedBy !== undefined) return false;
    if (options.onlyKeys !== undefined && !options.onlyKeys.has(item.key)) return false;
    if (options.mode === 'apply') return MUTATING.has(item.kind);
    // Repair restores what drifted. Blueprint changes are an apply's job, so
    // an operator reviewing a repair never sees new resources appear.
    return item.kind === 'DRIFT' && (item.strictDrift === true || options.includeSoft === true);
  });
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorCode(error: unknown): number | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'number'
  ) {
    return error.code;
  }
  return null;
}

function describe(error: unknown): string {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : 'Unknown error';
  return code === null ? message : `${message} (Discord ${String(code)})`;
}

export async function executePlan(
  items: readonly PlanItem[],
  state: DesiredState,
  snapshot: GuildSnapshot,
  registryEntries: readonly RegistryEntry[],
  adapter: GuildAdapter,
  store: RegistryStore,
  options: ExecuteOptions,
): Promise<ExecutionResult> {
  const registry = new Map(registryEntries.map((entry) => [entry.logicalKey, entry]));
  const roleIds = new Set(snapshot.roles.map((role) => role.id));
  const channelIds = new Set(snapshot.channels.map((channel) => channel.id));

  // Seed with what exists right now; creations are added as they happen.
  const ids = new Map<string, string>();
  for (const entry of registryEntries) {
    if (entry.discordId === null) continue;
    const alive =
      entry.resourceType === 'ROLE'
        ? roleIds.has(entry.discordId)
        : entry.resourceType === 'CHANNEL' || entry.resourceType === 'CATEGORY'
          ? channelIds.has(entry.discordId)
          : true;
    if (alive) ids.set(entry.logicalKey, entry.discordId);
  }
  const resolve = (key: string): string | null =>
    key === '@everyone'
      ? snapshot.id
      : key === 'bot'
        ? snapshot.bot.userId
        : (ids.get(key) ?? null);

  const roles = new Map(state.roles.map((role) => [role.key, role]));
  const channels = new Map(state.channels.map((channel) => [channel.key, channel]));
  const panels = new Map(state.panels.map((panel) => [panel.key, panel]));
  const assets = new Map(state.assets.map((asset) => [asset.key, asset]));
  const automod = new Map(state.automod.map((rule) => [rule.key, rule]));

  const work = selectExecutable(items, options);
  const progress = Object.fromEntries(
    PHASES.map((phase) => [
      phase,
      { done: 0, total: work.filter((item) => item.phase === phase).length },
    ]),
  ) as Record<Phase, { done: number; total: number }>;

  const applied: AppliedChange[] = [];
  const failed: { key: string; message: string }[] = [];
  const skipped: { key: string; reason: string }[] = [];
  const limit = options.maxConsecutiveFailures ?? 5;
  let consecutive = 0;
  let aborted = false;

  const report = async (current: string | null) => {
    await options.onProgress?.({ ...progress, current });
  };

  const record = async (
    key: string,
    resourceType: ResourceType,
    discordId: string,
    patch: Partial<RegistryEntry> & { created?: boolean },
  ) => {
    const previous = registry.get(key);
    const { created, ...rest } = patch;
    const entry: RegistryEntry = {
      logicalKey: key,
      resourceType,
      discordId,
      channelId: previous?.channelId ?? null,
      managed: true,
      contentHash: previous?.contentHash ?? null,
      configurationHash: previous?.configurationHash ?? null,
      createdByRunId: created === true ? options.runId : (previous?.createdByRunId ?? null),
      ...rest,
      metadata: {
        ...(previous?.metadata ?? {}),
        ...(rest.metadata ?? {}),
        blueprintVersion: options.blueprintVersion,
      },
    };
    await store.upsert(entry);
    registry.set(key, entry);
    ids.set(key, discordId);
  };

  const hashesAfter = (
    entry: RegistryEntry | undefined,
    strictHash: string,
    softHash: string,
    applyStrict: boolean,
    applySoft: boolean,
  ) => ({
    // A group left alone keeps its old hash, so an operator's edit stays
    // classified as drift instead of being silently blessed.
    strictHash: applyStrict ? strictHash : entry?.metadata.strictHash,
    softHash: applySoft ? softHash : entry?.metadata.softHash,
  });

  const shouldApply = (
    item: PlanItem,
    entry: RegistryEntry | undefined,
    group: 'strict' | 'soft',
    desired: string,
  ) => {
    const stored = group === 'strict' ? entry?.metadata.strictHash : entry?.metadata.softHash;
    if (stored !== desired) return true; // blueprint change, adoption, or first apply
    return (
      options.mode === 'repair' &&
      item.kind === 'DRIFT' &&
      (group === 'strict' || options.includeSoft === true)
    );
  };

  const emojis = (): Map<string, EmojiRef> => {
    const map = new Map<string, EmojiRef>();
    for (const asset of state.assets) {
      const id = ids.get(asset.key);
      if (asset.type === 'EMOJI' && id !== undefined)
        map.set(asset.key, { id, name: asset.name, animated: asset.animated });
    }
    return map;
  };

  const run = async (item: PlanItem): Promise<string | null> => {
    const entry = registry.get(item.key);
    const missing =
      item.kind === 'CREATE' ||
      (item.kind === 'DRIFT' && item.discordId !== null && resolveExisting(item) === null);

    switch (item.resourceType) {
      case 'ROLE': {
        if (item.key === 'hierarchy.roles') {
          const ordered = state.roles
            .map((role) => ids.get(role.key))
            .filter((id): id is string => id !== undefined);
          await adapter.orderRoles(ordered);
          return 'ordered';
        }
        const role = roles.get(item.key);
        if (role === undefined) return null;
        const strictHash = stableHash(roleStrict(role));
        const softHash = stableHash(roleSoft(role));
        const name =
          typeof entry?.metadata.alternativeName === 'string'
            ? entry.metadata.alternativeName
            : role.name;
        if (missing) {
          const id = await adapter.createRole({ ...rolePayload(role), name });
          await record(item.key, 'ROLE', id, {
            created: true,
            configurationHash: stableHash([strictHash, softHash]),
            metadata: { strictHash, softHash },
          });
          return 'created';
        }
        const id = resolveExisting(item);
        if (id === null) return null;
        const applyStrict = shouldApply(item, entry, 'strict', strictHash);
        const applySoft = shouldApply(item, entry, 'soft', softHash);
        await adapter.editRole(id, {
          ...(applyStrict ? roleStrict(role) : {}),
          ...(applySoft ? { ...roleSoft(role), name } : {}),
        });
        await record(item.key, 'ROLE', id, {
          metadata: hashesAfter(entry, strictHash, softHash, applyStrict, applySoft),
        });
        return 'updated';
      }

      case 'CATEGORY':
      case 'CHANNEL': {
        const channel = channels.get(item.key);
        if (channel === undefined) return null;
        const parentId = channel.parent === undefined ? null : resolve(channel.parent);
        if (channel.parent !== undefined && parentId === null) {
          skipped.push({ key: item.key, reason: 'Its category does not exist' });
          return null;
        }
        const overwrites = resolveOverwrites(channel.overwrites, resolve);
        const strictHash = channelStrictHash(channel, (key) => ids.has(key));
        const softHash = stableHash(channelSoft(channel));
        const name =
          typeof entry?.metadata.alternativeName === 'string'
            ? entry.metadata.alternativeName
            : channel.name;
        if (missing) {
          const id = await adapter.createChannel({
            ...channelPayload(channel, parentId, overwrites),
            name,
          });
          await record(item.key, item.resourceType, id, {
            created: true,
            configurationHash: stableHash([strictHash, softHash]),
            metadata: { strictHash, softHash },
          });
          return 'created';
        }
        const id = resolveExisting(item);
        if (id === null) return null;
        const applyStrict = shouldApply(item, entry, 'strict', strictHash);
        const applySoft = shouldApply(item, entry, 'soft', softHash);
        const soft = channelPayload(channel, parentId, overwrites);
        await adapter.editChannel(id, {
          ...(applyStrict ? { parentId, overwrites } : {}),
          ...(applySoft
            ? {
                name,
                ...(soft.topic === undefined ? {} : { topic: soft.topic }),
                ...(soft.slowmodeSeconds === undefined
                  ? {}
                  : { slowmodeSeconds: soft.slowmodeSeconds }),
                ...(soft.userLimit === undefined ? {} : { userLimit: soft.userLimit }),
              }
            : {}),
        });
        await record(item.key, item.resourceType, id, {
          metadata: hashesAfter(entry, strictHash, softHash, applyStrict, applySoft),
        });
        return item.kind === 'PERMISSION_CHANGE' ? 'permissions' : 'updated';
      }

      case 'EMOJI':
      case 'STICKER': {
        const asset = assets.get(item.key);
        if (asset === undefined || !missing) return null;
        const data = await options.readAsset(asset);
        try {
          const id =
            asset.type === 'EMOJI'
              ? await adapter.createEmoji(asset.name, data)
              : await adapter.createSticker(
                  asset.name,
                  asset.tags ?? '⭐',
                  asset.description ?? asset.name,
                  data,
                );
          await record(item.key, asset.type, id, { created: true, contentHash: asset.hash });
          return 'uploaded';
        } catch (error) {
          const code = errorCode(error);
          if (code !== null && CAPACITY_CODES.has(code)) {
            skipped.push({ key: item.key, reason: 'CAPACITY_BLOCKED' });
            return null;
          }
          throw error;
        }
      }

      case 'PANEL': {
        const panel = panels.get(item.key);
        if (panel === undefined) return null;
        const channelId = resolve(panel.channel);
        if (channelId === null) {
          skipped.push({ key: item.key, reason: 'Its channel does not exist' });
          return null;
        }
        const payload = options.renderPanel(panel, emojis());
        const contentHash = panelHash(payload);
        if (item.kind === 'UPDATE' && entry?.discordId != null && entry.channelId === channelId) {
          const edited = await adapter.editMessage(channelId, entry.discordId, payload);
          if (edited) {
            await record(item.key, 'PANEL', entry.discordId, { channelId, contentHash });
            return 'edited';
          }
        }
        const messageId = await adapter.sendMessage(channelId, payload);
        await record(item.key, 'PANEL', messageId, { channelId, contentHash, created: true });
        return 'posted';
      }

      case 'AUTOMOD': {
        const rule = automod.get(item.key);
        if (rule === undefined) return null;
        const payload = {
          name: rule.name,
          trigger: rule.trigger,
          alertChannelId: rule.alertChannel === undefined ? null : resolve(rule.alertChannel),
          exemptRoleIds: rule.exemptRoles.map(resolve).filter((id): id is string => id !== null),
        };
        const existing = item.discordId;
        if (
          item.kind === 'DRIFT' &&
          existing !== null &&
          snapshot.automodRules.some((r) => r.id === existing)
        ) {
          await adapter.setAutoModEnabled(existing, true);
          return 're-enabled';
        }
        if (item.kind === 'UPDATE' && existing !== null) {
          await adapter.editAutoModRule(existing, { ...payload, enabled: true });
          await record(item.key, 'AUTOMOD', existing, { configurationHash: stableHash(rule) });
          return 'updated';
        }
        const id = await adapter.createAutoModRule(payload);
        await record(item.key, 'AUTOMOD', id, {
          created: true,
          configurationHash: stableHash(rule),
        });
        return 'created';
      }

      case 'SPACE':
        return null;
    }
  };

  function resolveExisting(item: PlanItem): string | null {
    if (item.discordId === null) return null;
    switch (item.resourceType) {
      case 'ROLE':
        return roleIds.has(item.discordId) ? item.discordId : null;
      case 'CATEGORY':
      case 'CHANNEL':
        return channelIds.has(item.discordId) ? item.discordId : null;
      case 'EMOJI':
        return snapshot.emojis.some((emoji) => emoji.id === item.discordId) ? item.discordId : null;
      case 'STICKER':
        return snapshot.stickers.some((sticker) => sticker.id === item.discordId)
          ? item.discordId
          : null;
      case 'PANEL':
      case 'AUTOMOD':
      case 'SPACE':
        return item.discordId;
    }
  }

  await report(null);
  for (const phase of PHASES) {
    for (const item of work.filter((candidate) => candidate.phase === phase)) {
      if (aborted) break;
      await report(item.label);
      try {
        const action = await run(item);
        consecutive = 0;
        if (action !== null) {
          applied.push({
            key: item.key,
            kind: item.kind,
            action,
            discordId: ids.get(item.key) ?? null,
            resourceType: item.resourceType,
          });
          await sleep(options.pacingMs ?? 0);
        }
      } catch (error) {
        failed.push({ key: item.key, message: describe(error) });
        consecutive += 1;
        // A run of consecutive failures is systemic (permissions, an outage).
        // Stopping keeps the registry consistent and the error readable; the
        // next apply resumes from here.
        if (consecutive >= limit) aborted = true;
      }
      progress[phase].done += 1;
    }
  }

  // Apply also confirms resources that already match: an adopted role or a
  // channel that was right all along gets its applied hashes recorded, so a
  // later edit in Discord is recognised as drift.
  if (options.mode === 'apply' && !aborted) {
    for (const item of items) {
      if (item.kind !== 'UNCHANGED' || item.discordId === null) continue;
      const entry = registry.get(item.key);
      if (!entry?.managed) continue;
      const role = roles.get(item.key);
      const channel = channels.get(item.key);
      const metadata = role
        ? { strictHash: stableHash(roleStrict(role)), softHash: stableHash(roleSoft(role)) }
        : channel
          ? {
              strictHash: channelStrictHash(channel, (key) => ids.has(key)),
              softHash: stableHash(channelSoft(channel)),
            }
          : null;
      if (metadata === null) continue;
      if (
        entry.metadata.strictHash === metadata.strictHash &&
        entry.metadata.softHash === metadata.softHash
      )
        continue;
      await record(item.key, entry.resourceType, item.discordId, { metadata });
    }
  }

  await report(null);
  return { applied, failed, skipped, aborted, ids };
}

function rolePayload(role: DesiredRole) {
  return {
    name: role.name,
    color: role.color,
    hoist: role.hoist,
    mentionable: role.mentionable,
    permissions: role.permissions,
  };
}

function channelPayload(
  channel: DesiredChannelState,
  parentId: string | null,
  overwrites: DesiredChannelState['overwrites'],
) {
  return {
    name: channel.name,
    kind: channel.effectiveKind,
    parentId,
    overwrites,
    ...(channel.kind === 'category' || channel.kind === 'voice'
      ? {}
      : { topic: channel.topic ?? null }),
    ...(channel.effectiveKind === 'text' ? { slowmodeSeconds: channel.slowmodeSeconds ?? 0 } : {}),
    ...(channel.kind === 'voice' ? { userLimit: channel.userLimit ?? 0 } : {}),
    ...(channel.effectiveKind === 'forum' && channel.forumTags !== undefined
      ? { forumTags: channel.forumTags }
      : {}),
  };
}
