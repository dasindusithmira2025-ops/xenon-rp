import { PermissionFlagsBits as P } from 'discord.js';

import { type BlueprintContext, buildDesiredState } from './blueprint';
import { parseFeatures } from './config';
import { executePlan, type ExecuteOptions, type ExecutionResult } from './execute';
import { panelHash, type PanelContext, type PanelPayload, renderPanel } from './panels';
import { planGuild, type PlanResult } from './plan';
import { GRANTABLE_BITS } from './policies';

import type {
  AutoModPayload,
  ChannelPayload,
  GuildAdapter,
  RegistryStore,
  RolePayload,
} from './ports';
import type {
  DesiredState,
  GuildSnapshot,
  RegistryEntry,
  SnapshotChannel,
  SnapshotRole,
} from './types';

/**
 * An in-memory guild for tests.
 *
 * Implements the adapter port faithfully enough that the full engine cycle -
 * plan, apply, status, repair, cleanup - runs without a network, and it is the
 * reason no automated test can ever touch the real Xenon server. Mutations are
 * logged, and `failOn` injects Discord failures at any operation.
 */

interface FakeChannel extends SnapshotChannel {
  messages: Map<string, PanelPayload>;
  humanHistory: boolean;
}

export class FakeGuild implements GuildAdapter {
  readonly id = '100000000000000000';
  name = 'Xenon Development';
  ownerId = '200000000000000000';
  features: string[] = ['COMMUNITY'];
  premiumTier = 0;
  readonly botUserId = '300000000000000000';
  readonly botRoleId = '300000000000000001';
  botPermissions: bigint =
    GRANTABLE_BITS |
    P.ManageRoles |
    P.ManageChannels |
    P.ManageGuild |
    P.ManageGuildExpressions |
    P.BanMembers |
    P.KickMembers |
    P.ModerateMembers |
    P.ManageNicknames |
    P.ViewAuditLog |
    P.MentionEveryone;

  readonly roles = new Map<string, SnapshotRole>();
  readonly channels = new Map<string, FakeChannel>();
  readonly emojis = new Map<string, { id: string; name: string; animated: boolean }>();
  readonly stickers = new Map<string, { id: string; name: string }>();
  readonly automod = new Map<
    string,
    { id: string; name: string; enabled: boolean; payload: AutoModPayload }
  >();
  readonly calls: string[] = [];
  failOn: ((operation: string, subject: string) => boolean) | null = null;
  private sequence = 1000;

  constructor() {
    this.roles.set(
      this.id,
      role(
        this.id,
        '@everyone',
        0,
        P.ViewChannel | P.SendMessages | P.Connect | P.Speak | P.ReadMessageHistory,
      ),
    );
    this.roles.set(this.botRoleId, { ...role(this.botRoleId, 'Xenon', 100, 0n), managed: true });
  }

  nextId(): string {
    this.sequence += 1;
    return `9${String(this.sequence).padStart(17, '0')}`;
  }

  private mutate(operation: string, subject: string): void {
    if (this.failOn?.(operation, subject) === true) {
      throw Object.assign(new Error(`Injected failure: ${operation} ${subject}`), { code: 50013 });
    }
    this.calls.push(`${operation}:${subject}`);
  }

  addChannel(
    channel: Omit<SnapshotChannel, 'id' | 'position' | 'overwrites'> & {
      overwrites?: SnapshotChannel['overwrites'];
    },
  ): string {
    const id = this.nextId();
    this.channels.set(id, {
      position: this.channels.size,
      overwrites: [],
      ...channel,
      id,
      messages: new Map(),
      humanHistory: false,
    });
    return id;
  }

  addRole(name: string, position = 5, permissions = 0n): string {
    const id = this.nextId();
    this.roles.set(id, role(id, name, position, permissions));
    return id;
  }

  channelByName(name: string): FakeChannel | undefined {
    return [...this.channels.values()].find((channel) => channel.name === name);
  }

  roleByName(name: string): SnapshotRole | undefined {
    return [...this.roles.values()].find((candidate) => candidate.name === name);
  }

  snapshot(panelRefs: readonly { channelId: string; messageId: string }[]): Promise<GuildSnapshot> {
    const panelMessages = new Set(
      panelRefs
        .filter((ref) => this.channels.get(ref.channelId)?.messages.has(ref.messageId) === true)
        .map((ref) => `${ref.channelId}:${ref.messageId}`),
    );
    return Promise.resolve({
      id: this.id,
      name: this.name,
      ownerId: this.ownerId,
      features: [...this.features],
      premiumTier: this.premiumTier,
      bot: {
        userId: this.botUserId,
        roleIds: [this.botRoleId],
        highestRolePosition: 100,
        permissions: this.botPermissions,
      },
      roles: [...this.roles.values()].map((entry) => ({ ...entry })),
      channels: [...this.channels.values()].map(
        ({ messages: _m, humanHistory: _h, ...channel }) => ({
          ...channel,
          overwrites: [...channel.overwrites],
        }),
      ),
      emojis: [...this.emojis.values()],
      stickers: [...this.stickers.values()],
      panelMessages,
      automodRules: [...this.automod.values()].map(({ id, name, enabled }) => ({
        id,
        name,
        enabled,
      })),
    });
  }

  createRole(payload: RolePayload): Promise<string> {
    this.mutate('createRole', payload.name);
    const id = this.nextId();
    this.roles.set(id, {
      ...role(id, payload.name, 1, payload.permissions),
      color: payload.color,
      hoist: payload.hoist,
      mentionable: payload.mentionable,
    });
    return Promise.resolve(id);
  }

  editRole(id: string, payload: Partial<RolePayload>): Promise<void> {
    this.mutate('editRole', id);
    const existing = this.roles.get(id);
    if (existing === undefined)
      return Promise.reject(Object.assign(new Error('Unknown role'), { code: 10011 }));
    this.roles.set(id, { ...existing, ...payload });
    return Promise.resolve();
  }

  orderRoles(ids: readonly string[]): Promise<void> {
    this.mutate('orderRoles', String(ids.length));
    ids.forEach((id, index) => {
      const existing = this.roles.get(id);
      if (existing !== undefined) this.roles.set(id, { ...existing, position: 99 - index });
    });
    return Promise.resolve();
  }

  deleteRole(id: string): Promise<void> {
    this.mutate('deleteRole', id);
    this.roles.delete(id);
    return Promise.resolve();
  }

  createChannel(payload: ChannelPayload): Promise<string> {
    this.mutate('createChannel', payload.name);
    const id = this.addChannel({
      name: payload.name,
      kind: payload.kind,
      parentId: payload.parentId,
      topic: payload.topic ?? null,
      overwrites: [...payload.overwrites],
      ...(payload.userLimit === undefined ? {} : { userLimit: payload.userLimit }),
      ...(payload.slowmodeSeconds === undefined
        ? {}
        : { slowmodeSeconds: payload.slowmodeSeconds }),
    });
    return Promise.resolve(id);
  }

  editChannel(id: string, payload: Partial<ChannelPayload>): Promise<void> {
    this.mutate('editChannel', id);
    const existing = this.channels.get(id);
    if (existing === undefined)
      return Promise.reject(Object.assign(new Error('Unknown channel'), { code: 10003 }));
    this.channels.set(id, {
      ...existing,
      ...(payload.name === undefined ? {} : { name: payload.name }),
      ...(payload.parentId === undefined ? {} : { parentId: payload.parentId }),
      ...(payload.overwrites === undefined ? {} : { overwrites: [...payload.overwrites] }),
      ...(payload.topic === undefined ? {} : { topic: payload.topic }),
      ...(payload.userLimit === undefined ? {} : { userLimit: payload.userLimit }),
      ...(payload.slowmodeSeconds === undefined
        ? {}
        : { slowmodeSeconds: payload.slowmodeSeconds }),
    });
    return Promise.resolve();
  }

  deleteChannel(id: string): Promise<void> {
    this.mutate('deleteChannel', id);
    this.channels.delete(id);
    return Promise.resolve();
  }

  createEmoji(name: string, _data: Buffer): Promise<string> {
    this.mutate('createEmoji', name);
    const limit = [50, 100, 150, 250][this.premiumTier] ?? 50;
    if ([...this.emojis.values()].filter((emoji) => !emoji.animated).length >= limit) {
      return Promise.reject(
        Object.assign(new Error('Maximum number of emojis reached'), { code: 30008 }),
      );
    }
    const id = this.nextId();
    this.emojis.set(id, { id, name, animated: false });
    return Promise.resolve(id);
  }

  createSticker(name: string): Promise<string> {
    this.mutate('createSticker', name);
    const id = this.nextId();
    this.stickers.set(id, { id, name });
    return Promise.resolve(id);
  }

  deleteEmoji(id: string): Promise<void> {
    this.mutate('deleteEmoji', id);
    this.emojis.delete(id);
    return Promise.resolve();
  }

  sendMessage(channelId: string, payload: PanelPayload): Promise<string> {
    this.mutate('sendMessage', channelId);
    const channel = this.channels.get(channelId);
    if (channel === undefined)
      return Promise.reject(Object.assign(new Error('Unknown channel'), { code: 10003 }));
    const id = this.nextId();
    channel.messages.set(id, payload);
    return Promise.resolve(id);
  }

  editMessage(channelId: string, messageId: string, payload: PanelPayload): Promise<boolean> {
    this.mutate('editMessage', messageId);
    const channel = this.channels.get(channelId);
    if (channel?.messages.has(messageId) !== true) return Promise.resolve(false);
    channel.messages.set(messageId, payload);
    return Promise.resolve(true);
  }

  createAutoModRule(payload: AutoModPayload): Promise<string> {
    this.mutate('createAutoModRule', payload.name);
    const id = this.nextId();
    this.automod.set(id, { id, name: payload.name, enabled: true, payload });
    return Promise.resolve(id);
  }

  editAutoModRule(id: string, payload: AutoModPayload & { enabled: boolean }): Promise<void> {
    this.mutate('editAutoModRule', id);
    this.automod.set(id, { id, name: payload.name, enabled: payload.enabled, payload });
    return Promise.resolve();
  }

  setAutoModEnabled(id: string, enabled: boolean): Promise<void> {
    this.mutate('setAutoModEnabled', id);
    const rule = this.automod.get(id);
    if (rule !== undefined) this.automod.set(id, { ...rule, enabled });
    return Promise.resolve();
  }

  channelHasHumanHistory(id: string): Promise<boolean | null> {
    return Promise.resolve(this.channels.get(id)?.humanHistory ?? false);
  }

  roleMemberCount(): Promise<number | null> {
    return Promise.resolve(null);
  }
}

function role(id: string, name: string, position: number, permissions: bigint): SnapshotRole {
  return {
    id,
    name,
    color: 0,
    hoist: false,
    mentionable: false,
    permissions,
    position,
    managed: false,
  };
}

// --- Cycle helpers -----------------------------------------------------------

function panelRefs(entries: readonly RegistryEntry[]): { channelId: string; messageId: string }[] {
  return entries.flatMap((entry) =>
    entry.resourceType === 'PANEL' && entry.discordId !== null && entry.channelId !== null
      ? [{ channelId: entry.channelId, messageId: entry.discordId }]
      : [],
  );
}

export function blueprintContext(overrides: Partial<BlueprintContext> = {}): BlueprintContext {
  return {
    features: parseFeatures({}),
    guildFeatures: ['COMMUNITY'],
    departments: [],
    organizations: [],
    assets: [],
    ...overrides,
  };
}

export function stubPanelContext(
  state: DesiredState,
  overrides: Partial<PanelContext> = {},
): PanelContext {
  return {
    siteUrl: 'https://xenonrp.lk',
    linksAllowed: true,
    connectUrl: 'https://cfx.re/join/xenon',
    rules: {
      version: 3,
      retrievedAt: new Date('2026-09-01T00:00:00Z'),
    },
    applications: {
      globallyOpen: true,
      whitelistOpen: true,
      open: [{ name: 'Whitelist', slug: 'whitelist' }],
    },
    departments: [],
    status: {
      aggregate: 'ONLINE',
      totalPlayers: 84,
      totalCapacity: 128,
      queue: 3,
      nextRestartAt: null,
      checkedAt: '2026-09-23T10:00:00Z',
      servers: [{ name: 'City', state: 'ONLINE', players: 84, max: 128 }],
    },
    emojis: new Map(),
    selfRoles: state.roles.filter((role) => role.selfAssignable),
    ...overrides,
  };
}

export async function planOnce(
  guild: FakeGuild,
  store: RegistryStore,
  state: DesiredState,
): Promise<PlanResult> {
  const entries = await store.list();
  const snapshot = await guild.snapshot(panelRefs(entries));
  const context = stubPanelContext(state);
  return planGuild({
    state,
    snapshot,
    registry: entries,
    panelHashes: new Map(
      state.panels
        .filter((panel) => !panel.live)
        .map((panel) => [panel.key, panelHash(renderPanel(panel, context))]),
    ),
  });
}

export async function executeOnce(
  guild: FakeGuild,
  store: RegistryStore,
  state: DesiredState,
  options: Partial<ExecuteOptions> = {},
): Promise<{ plan: PlanResult; result: ExecutionResult }> {
  const plan = await planOnce(guild, store, state);
  const entries = await store.list();
  const snapshot = await guild.snapshot(panelRefs(entries));
  const result = await executePlan(plan.items, state, snapshot, entries, guild, store, {
    mode: 'apply',
    runId: 'run-1',
    blueprintVersion: state.version,
    renderPanel: (panel, emojis) => renderPanel(panel, stubPanelContext(state, { emojis })),
    readAsset: () => Promise.resolve(Buffer.from('png')),
    ...options,
  });
  return { plan, result };
}

export { buildDesiredState };
