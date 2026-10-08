import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AuditLogEvent,
  ChannelType,
  Collection,
  PermissionsBitField,
  PermissionFlagsBits as P,
  type Guild,
  type GuildAuditLogsEntry,
  type GuildMember,
  type Message,
} from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JsonDiscordRuntimeStore } from '../runtime-store';

import { DEFAULT_SECURITY_CONFIG, createIncident, type EnforcementMode } from './model';
import { EnforcementBlockedError, SecurityService, enforcedProtections } from './service';

const guildId = '12345678901234567';
const ownerId = '22345678901234567';
const channelId = '32345678901234567';
const quarantineId = '42345678901234567';
const actorId = '52345678901234567';
const botId = '62345678901234567';
const botRoleId = '72345678901234567';
const dangerousRoleId = '72345678901234001';
const alertsId = '82345678901234567';
const T0 = Date.parse('2026-03-01T12:00:00.000Z');
const BOT_PERMISSIONS =
  P.ViewChannel |
  P.ManageChannels |
  P.ManageRoles |
  P.SendMessages |
  P.SendMessagesInThreads |
  P.CreatePublicThreads |
  P.CreatePrivateThreads |
  P.Connect |
  P.Speak;
const MINUTE = 60_000;
const NON_ENFORCING = ['OBSERVE', 'ALERT'] as const;

interface TestRole {
  readonly id: string;
  readonly position: number;
  readonly name?: string;
  readonly managed?: boolean;
  readonly permissions?: PermissionsBitField;
}
interface TestOverwrite {
  readonly id: string;
  readonly type: 0 | 1;
  readonly allow: PermissionsBitField;
  readonly deny: PermissionsBitField;
}
interface TestMember {
  readonly id: string;
  readonly guild: Guild;
  readonly manageable: boolean;
  readonly moderatable: boolean;
  readonly permissions: PermissionsBitField;
  readonly roles: {
    readonly cache: Collection<string, TestRole>;
    readonly highest: TestRole & { comparePositionTo(role: TestRole): number };
    readonly add: ReturnType<typeof vi.fn>;
    readonly remove: ReturnType<typeof vi.fn>;
  };
  readonly timeout: ReturnType<typeof vi.fn>;
  readonly send: ReturnType<typeof vi.fn>;
  readonly user: { readonly id: string; readonly bot: boolean; readonly createdTimestamp: number };
  readonly voice: { readonly channelId: string | null };
  permissionsIn(channel: object): PermissionsBitField;
}

function createWorld() {
  const everyone: TestRole = {
    id: guildId,
    name: '@everyone',
    position: 0,
    permissions: new PermissionsBitField(0n),
  };
  const quarantineRole: TestRole = {
    id: quarantineId,
    name: 'Xenon Quarantine',
    position: 2,
    permissions: new PermissionsBitField(0n),
    managed: false,
  };
  const botRole: TestRole = {
    id: botRoleId,
    name: 'XenonBot',
    position: 10,
    permissions: new PermissionsBitField(BOT_PERMISSIONS),
    managed: false,
  };
  const dangerousRole: TestRole = {
    id: dangerousRoleId,
    name: 'Mods',
    position: 3,
    permissions: new PermissionsBitField(P.ManageChannels),
    managed: false,
  };
  const roleCache = new Collection<string, TestRole>([
    [guildId, everyone],
    [quarantineId, quarantineRole],
    [botRoleId, botRole],
    [dangerousRoleId, dangerousRole],
  ]);
  const overwrites = new Collection<string, TestOverwrite>();
  const members = new Collection<string, TestMember>();
  const permissionsIn = (member: TestMember): PermissionsBitField => {
    let bits = member.permissions.bitfield;
    const apply = (current: bigint, overwrite: TestOverwrite): bigint =>
      (current & ~overwrite.deny.bitfield) | overwrite.allow.bitfield;
    const everyoneOverwrite = overwrites.get(guildId);
    if (everyoneOverwrite !== undefined) bits = apply(bits, everyoneOverwrite);
    const roleOverwrites = [...overwrites.values()].filter(
      (overwrite) => overwrite.type === 0 && member.roles.cache.has(overwrite.id),
    );
    const denied = roleOverwrites.reduce((value, overwrite) => value | overwrite.deny.bitfield, 0n);
    const allowed = roleOverwrites.reduce(
      (value, overwrite) => value | overwrite.allow.bitfield,
      0n,
    );
    bits = (bits & ~denied) | allowed;
    const own = overwrites.get(member.id);
    if (own?.type === 1) bits = apply(bits, own);
    return new PermissionsBitField(bits);
  };
  const overwriteManager = {
    cache: overwrites,
    edit: vi.fn(
      (
        target: string | { id: string },
        options: Record<string, boolean | null>,
        metadata?: { type?: 0 | 1 },
      ) => {
        const targetId = typeof target === 'string' ? target : target.id;
        const old = overwrites.get(targetId);
        let allow = old?.allow.bitfield ?? 0n;
        let deny = old?.deny.bitfield ?? 0n;
        for (const [name, value] of Object.entries(options)) {
          const permission = P[name as keyof typeof P];
          if (typeof permission !== 'bigint') continue;
          allow &= ~permission;
          deny &= ~permission;
          if (value === true) allow |= permission;
          else if (value === false) deny |= permission;
        }
        overwrites.set(targetId, {
          id: targetId,
          type: metadata?.type ?? (roleCache.has(targetId) ? 0 : 1),
          allow: new PermissionsBitField(allow),
          deny: new PermissionsBitField(deny),
        });
        return Promise.resolve();
      },
    ),
    set: vi.fn(() => Promise.resolve()),
  };
  const channel = {
    id: channelId,
    name: 'general',
    type: ChannelType.GuildText,
    parent: null,
    parentId: null,
    rateLimitPerUser: 0,
    permissionOverwrites: overwriteManager,
    setRateLimitPerUser: vi.fn((seconds: number) => {
      channel.rateLimitPerUser = seconds;
      return Promise.resolve();
    }),
  };
  const alerts = {
    id: alertsId,
    name: 'security-alerts',
    type: ChannelType.GuildText,
    send: vi.fn(() => Promise.resolve()),
  };
  const channelCache = new Collection<string, typeof channel | typeof alerts>([
    [channelId, channel],
    [alertsId, alerts],
  ]);
  const memberManager = {
    cache: members,
    fetch: vi.fn((input: string | { readonly user: string }) => {
      const id = typeof input === 'string' ? input : input.user;
      const member = members.get(id);
      return member === undefined
        ? Promise.reject(new Error(`Missing test member ${id}`))
        : Promise.resolve(member);
    }),
  };
  const autoModRules = new Collection<string, { id: string; name: string }>();
  const autoModerationRules = {
    fetch: vi.fn(() => Promise.resolve(autoModRules)),
    create: vi.fn((options: { name: string }) => {
      const rule = { id: `9${String(autoModRules.size).padStart(16, '0')}`, name: options.name };
      autoModRules.set(rule.id, rule);
      return Promise.resolve(rule);
    }),
    edit: vi.fn(() => Promise.resolve()),
  };
  const guild = {
    id: guildId,
    ownerId,
    roles: {
      cache: roleCache,
      everyone,
      fetch: vi.fn((id: string) => Promise.resolve(roleCache.get(id) ?? null)),
    },
    channels: {
      cache: channelCache,
      fetch: vi.fn((id: string) => Promise.resolve(channelCache.get(id) ?? null)),
    },
    members: memberManager,
    autoModerationRules,
    client: { user: { id: botId } },
  } as unknown as Guild;
  const makeMember = (
    id: string,
    roleIds: readonly string[] = [],
    options: { readonly permissions?: bigint; readonly bot?: boolean } = {},
  ): TestMember => {
    const cache = new Collection<string, TestRole>(
      roleIds.map((roleId) => [roleId, roleCache.get(roleId) ?? { id: roleId, position: 1 }]),
    );
    const highestPosition = options.bot === true ? 10 : 1;
    const member: TestMember = {
      id,
      guild,
      manageable: true,
      moderatable: true,
      permissions: new PermissionsBitField(options.permissions ?? 0n),
      roles: {
        cache,
        highest: {
          id: `test-role-${id}`,
          position: highestPosition,
          comparePositionTo: (role) => highestPosition - role.position,
        },
        add: vi.fn((role: TestRole) => {
          cache.set(role.id, role);
          return Promise.resolve();
        }),
        remove: vi.fn((roles: TestRole | readonly string[]) => {
          for (const key of Array.isArray(roles) ? roles : [(roles as TestRole).id])
            cache.delete(key as string);
          return Promise.resolve();
        }),
      },
      timeout: vi.fn(() => Promise.resolve()),
      send: vi.fn(() => Promise.resolve()),
      user: { id, bot: options.bot ?? false, createdTimestamp: Date.now() },
      voice: { channelId: null },
      permissionsIn: () => permissionsIn(member),
    };
    members.set(id, member);
    return member;
  };
  const bot = makeMember(botId, [botRoleId], {
    permissions: BOT_PERMISSIONS,
    bot: true,
  });
  Object.defineProperty(memberManager, 'me', { value: bot });
  return {
    guild,
    channel,
    alerts,
    overwriteManager,
    memberManager,
    autoModerationRules,
    members,
    makeMember,
  };
}
type World = ReturnType<typeof createWorld>;

const raidConfig = {
  lockdownChannelIds: [channelId],
  channels: { alerts: alertsId, audit: null, modLogs: null },
  raidSlowmodeSeconds: 30,
  quarantineRoleId: quarantineId,
};
const criticalRaid = {
  ...raidConfig,
  autoLockdownOnCritical: true,
  raidThresholds: {
    warning10s: 1,
    raid10s: 2,
    critical10s: 3,
    warning30s: 1,
    raid30s: 2,
    critical30s: 3,
    newAccountRatio: 1,
  },
};
const sustainedRaid = {
  ...raidConfig,
  autoLockdownOnCritical: false,
  raidThresholds: { ...criticalRaid.raidThresholds, critical10s: 10, critical30s: 10 },
};

function expectNoGuildMutations(world: World): void {
  expect(world.overwriteManager.edit).not.toHaveBeenCalled();
  expect(world.overwriteManager.set).not.toHaveBeenCalled();
  expect(world.channel.setRateLimitPerUser).not.toHaveBeenCalled();
  expect(world.autoModerationRules.create).not.toHaveBeenCalled();
  expect(world.autoModerationRules.edit).not.toHaveBeenCalled();
  for (const member of world.members.values()) {
    expect(member.roles.add).not.toHaveBeenCalled();
    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(member.timeout).not.toHaveBeenCalled();
    expect(member.send).not.toHaveBeenCalled();
  }
}

function channelDeleteEntry(index: number, id = `9234567890123450${String(index)}`) {
  return {
    id,
    action: AuditLogEvent.ChannelDelete,
    executorId: actorId,
    targetId: `4234567890123450${String(index)}`,
    createdTimestamp: Date.now(),
    reason: null,
    changes: [],
    extra: null,
  } as unknown as GuildAuditLogsEntry;
}

describe('security enforcement mode', () => {
  let directory = '';
  let storePath = '';
  let store: JsonDiscordRuntimeStore;

  const configure = async (patch: Record<string, unknown>): Promise<void> => {
    await store.updateGuild(guildId, (current) => ({
      ...current,
      security: { ...current.security, config: { ...current.security.config, ...patch } },
    }));
  };
  const state = async () => (await store.getGuild(guildId)).security;
  const arrival = (world: World, id: string): GuildMember =>
    world.makeMember(id) as unknown as GuildMember;
  const burst = async (service: SecurityService, world: World): Promise<void> => {
    for (const id of ['12345678901234001', '12345678901234002', '12345678901234003'])
      await service.handleJoin(arrival(world, id));
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    directory = await mkdtemp(join(tmpdir(), 'xenon-enforcement-'));
    storePath = join(directory, 'discord-runtime.json');
    store = new JsonDiscordRuntimeStore(storePath);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  });

  describe.each(NON_ENFORCING)('%s mode', (mode: Exclude<EnforcementMode, 'ENFORCE'>) => {
    const prefix = mode === 'ALERT' ? 'ALERT ONLY' : 'OBSERVED';

    it('records a raid burst without quarantine, lockdown or slowmode and notifies only in ALERT', async () => {
      const world = createWorld();
      await configure({ ...criticalRaid, enforcementMode: mode });
      const service = new SecurityService(store);

      await burst(service, world);

      expectNoGuildMutations(world);
      const current = await state();
      expect(current.lockdown).toBeNull();
      expect(current.quarantines).toHaveLength(0);
      expect(current.raidResponse).toBeNull();
      const critical = current.incidents.find(
        (incident) => incident.rule === 'JOIN_WINDOW_CRITICAL',
      );
      expect(critical).toMatchObject({
        status: 'OPEN',
        actionTaken: [`${prefix}: would quarantine, lock down, and apply 30s slowmode`],
      });
      expect(world.alerts.send).toHaveBeenCalledTimes(mode === 'ALERT' ? 2 : 0);
    });

    it('records manual raid-mode arrivals without quarantining them', async () => {
      const world = createWorld();
      await configure({ ...raidConfig, enforcementMode: mode, raidMode: 'ON' });
      const service = new SecurityService(store);

      await service.handleJoin(arrival(world, '12345678901234001'));

      expectNoGuildMutations(world);
      const current = await state();
      expect(current.quarantines).toHaveLength(0);
      expect(current.incidents).toHaveLength(1);
      expect(current.incidents[0]).toMatchObject({
        rule: 'RAID_MODE_ARRIVAL',
        status: 'OPEN',
        actionTaken: [`${prefix}: would quarantine`],
      });
      expect(world.alerts.send).toHaveBeenCalledTimes(mode === 'ALERT' ? 1 : 0);
    });

    it('keeps a CRITICAL anti-nuke incident open without removing roles, timing out or locking down', async () => {
      const world = createWorld();
      world.makeMember(actorId, [dangerousRoleId]);
      await configure({ ...raidConfig, enforcementMode: mode });
      const service = new SecurityService(store);

      for (let index = 0; index < 3; index += 1)
        await service.handleAuditEntry(channelDeleteEntry(index), world.guild);

      expectNoGuildMutations(world);
      const current = await state();
      expect(current.lockdown).toBeNull();
      const critical = current.incidents.find((incident) => incident.severity === 'CRITICAL');
      expect(critical).toMatchObject({
        status: 'OPEN',
        actionTaken: [`${prefix}: would remove dangerous roles and lock down`],
      });
      expect(world.alerts.send.mock.calls.length > 0).toBe(mode === 'ALERT');
    });

    it('creates exactly one incident for a repeated audit entry', async () => {
      const world = createWorld();
      world.makeMember(actorId, [dangerousRoleId]);
      await configure({ ...raidConfig, enforcementMode: mode });
      const service = new SecurityService(store);
      const entries = [0, 1, 2].map((index) => channelDeleteEntry(index));

      for (const entry of entries) await service.handleAuditEntry(entry, world.guild);
      const before = (await state()).incidents.length;
      await service.handleAuditEntry(entries[2]!, world.guild);

      const current = await state();
      expect(current.incidents).toHaveLength(before);
      expect(current.incidents.filter((incident) => incident.severity === 'CRITICAL')).toHaveLength(
        1,
      );
      expectNoGuildMutations(world);
    });

    describe('message responses', () => {
      let counter = 0;
      const channels = [
        '92345678901234561',
        '92345678901234562',
        '92345678901234563',
        '92345678901234564',
        '92345678901234565',
      ];
      const makeMessage = (
        world: World,
        member: TestMember,
        content: string,
        at: number,
        inChannel = channels[0]!,
      ) => {
        counter += 1;
        return {
          id: `1${String(counter).padStart(16, '0')}`,
          guild: world.guild,
          member,
          author: { id: member.id, bot: false },
          webhookId: null,
          channelId: inChannel,
          content,
          createdTimestamp: at,
          inGuild: () => true,
          mentions: { users: { size: 0 }, roles: { size: 0 }, everyone: false },
          delete: vi.fn(() => Promise.resolve()),
        };
      };

      it('reports spam that would be timed out without deleting, timing out, messaging or opening a case', async () => {
        const world = createWorld();
        const member = world.makeMember('92345678901234567');
        await configure({ ...raidConfig, enforcementMode: mode });
        const service = new SecurityService(store);
        service.setMessageContentAvailable(true);
        const messages = ['alpha', 'bravo', 'charlie', 'delta', 'echo'].map((content, index) =>
          makeMessage(world, member, content, T0 + index * 100, channels[index]),
        );

        for (const message of messages) await service.handleMessage(message as unknown as Message);

        for (const message of messages) expect(message.delete).not.toHaveBeenCalled();
        expectNoGuildMutations(world);
        const current = await state();
        expect(current.cases).toHaveLength(0);
        const spam = current.incidents.filter((incident) => incident.source === 'SpamGuard');
        expect(spam.length).toBeGreaterThan(0);
        const response = spam.find((incident) => /^SPAM_(TIMEOUT|ESCALATE)$/.test(incident.rule));
        expect(response).toMatchObject({ status: 'OPEN' });
        expect(response?.actionTaken[0]).toBe(
          `${prefix}: would delete the message and time out the member for 600 seconds`,
        );
        expect(world.alerts.send.mock.calls.length > 0).toBe(mode === 'ALERT');
      });

      it('reports a blocked link without deleting the message', async () => {
        const world = createWorld();
        const member = world.makeMember('92345678901234567');
        await configure({
          ...raidConfig,
          enforcementMode: mode,
          modules: { ...DEFAULT_SECURITY_CONFIG.modules, spam: false },
          links: {
            ...DEFAULT_SECURITY_CONFIG.links,
            action: 'BLOCK',
            blockedDomains: ['bad.example'],
          },
        });
        const service = new SecurityService(store);
        service.setMessageContentAvailable(true);
        const message = makeMessage(world, member, 'see https://bad.example/x', T0);

        await service.handleMessage(message as unknown as Message);

        expect(message.delete).not.toHaveBeenCalled();
        expectNoGuildMutations(world);
        const current = await state();
        expect(current.cases).toHaveLength(0);
        expect(current.incidents).toHaveLength(1);
        expect(current.incidents[0]).toMatchObject({
          source: 'LinkGuard',
          rule: 'LINK_BLOCK',
          status: 'OPEN',
          actionTaken: [`${prefix}: would delete the message`],
        });
      });
    });

    it('blocks automatic AutoMod sync, lockdown and quarantine called outside a manual context', async () => {
      const world = createWorld();
      await configure({ ...raidConfig, enforcementMode: mode });
      const service = new SecurityService(store);
      const member = world.makeMember('92345678901234567');

      await expect(service.syncAutoMod(world.guild)).rejects.toThrow(
        `ENFORCEMENT_MODE_BLOCKED:${mode}:AUTOMOD_SYNC`,
      );
      await expect(service.syncAutoMod(world.guild)).rejects.toBeInstanceOf(
        EnforcementBlockedError,
      );
      expect(await service.activateLockdown(world.guild, 'auto', null, true)).toBe(
        `ENFORCEMENT_MODE_BLOCKED:${mode}`,
      );
      expect(await service.quarantine(member as unknown as GuildMember, 'auto', botId)).toBe(
        `ENFORCEMENT_MODE_BLOCKED:${mode}`,
      );

      expectNoGuildMutations(world);
      const current = await state();
      expect(current.lockdown).toBeNull();
      expect(current.quarantines).toHaveLength(0);
      expect(current.incidents).toHaveLength(0);
    });

    it('lets manual staff actions run in the same mode', async () => {
      const world = createWorld();
      await configure({ ...raidConfig, enforcementMode: mode });
      const service = new SecurityService(store);
      const member = world.makeMember('92345678901234567');

      await service.runManual(ownerId, () => service.syncAutoMod(world.guild));
      expect(world.autoModerationRules.create).toHaveBeenCalledTimes(3);
      expect(
        await service.runManual(ownerId, () =>
          service.activateLockdown(world.guild, 'manual', null, false, ownerId),
        ),
      ).toMatch(/^LOCKDOWN_ACTIVE:/);
      expect(
        await service.runManual(ownerId, () =>
          service.quarantine(member as unknown as GuildMember, 'manual', ownerId),
        ),
      ).toMatch(/^QUARANTINED:/);
      expect(world.overwriteManager.edit).toHaveBeenCalled();
      expect(member.roles.add).toHaveBeenCalled();
    });
  });

  it('still performs every automatic response in ENFORCE mode', async () => {
    const world = createWorld();
    const actor = world.makeMember(actorId, [dangerousRoleId]);
    await configure({ ...sustainedRaid, enforcementMode: 'ENFORCE' });
    const service = new SecurityService(store);

    await burst(service, world);
    expect(world.overwriteManager.edit).toHaveBeenCalled();
    expect(world.channel.setRateLimitPerUser).toHaveBeenCalledWith(30, expect.any(String));
    expect((await state()).quarantines).toHaveLength(2);
    expect((await state()).raidResponse?.slowmode).toHaveLength(1);

    for (let index = 0; index < 3; index += 1)
      await service.handleAuditEntry(channelDeleteEntry(index), world.guild);
    expect(actor.roles.remove).toHaveBeenCalledTimes(1);
  });

  it('blocks later automatic mutations when the mode changes after the boundary check passed', async () => {
    const world = createWorld();
    const actor = world.makeMember(actorId, [dangerousRoleId]);
    await configure({ ...raidConfig, enforcementMode: 'ENFORCE' });
    const service = new SecurityService(store);
    const originalFetch = world.memberManager.fetch;
    world.memberManager.fetch = vi.fn(async (input: string | { readonly user: string }) => {
      await configure({ enforcementMode: 'OBSERVE' });
      return originalFetch(input);
    });

    for (let index = 0; index < 3; index += 1)
      await service.handleAuditEntry(channelDeleteEntry(index), world.guild);

    expect(actor.roles.remove).not.toHaveBeenCalled();
    expect(actor.timeout).not.toHaveBeenCalled();
    expect(world.overwriteManager.edit).not.toHaveBeenCalled();
    const critical = (await state()).incidents.find((incident) => incident.severity === 'CRITICAL');
    expect(critical?.status).toBe('OPEN');
    expect(critical?.actionTaken).toContain('ENFORCEMENT_MODE_BLOCKED:OBSERVE:ROLES_REMOVE');
    expect(critical?.actionTaken).toContain('ENFORCEMENT_MODE_BLOCKED:OBSERVE');
  });

  it('reports a blocked containment timeout without counting it as contained', async () => {
    const world = createWorld();
    const actor = world.makeMember(actorId);
    await configure({ ...raidConfig, autoLockdownOnCritical: false, enforcementMode: 'ENFORCE' });
    const service = new SecurityService(store);
    const originalFetch = world.memberManager.fetch;
    world.memberManager.fetch = vi.fn(async (input: string | { readonly user: string }) => {
      await configure({ enforcementMode: 'ALERT' });
      return originalFetch(input);
    });

    for (let index = 0; index < 3; index += 1)
      await service.handleAuditEntry(channelDeleteEntry(index), world.guild);

    expect(actor.timeout).not.toHaveBeenCalled();
    const critical = (await state()).incidents.find((incident) => incident.severity === 'CRITICAL');
    expect(critical).toMatchObject({
      status: 'OPEN',
      actionTaken: ['ENFORCEMENT_MODE_BLOCKED:ALERT:TIMEOUT'],
    });
  });

  it('keeps restrictions created under ENFORCE intact after switching to OBSERVE and recovers them manually', async () => {
    const world = createWorld();
    await configure({ ...sustainedRaid, enforcementMode: 'ENFORCE' });
    const service = new SecurityService(store);
    await burst(service, world);
    expect(await service.activateLockdown(world.guild, 'manual', null, false, ownerId)).toMatch(
      /^LOCKDOWN_ACTIVE:/,
    );
    expect(world.channel.rateLimitPerUser).toBe(30);

    const change = await service.setEnforcementMode(world.guild, 'OBSERVE', ownerId);
    expect(change).toEqual({
      previous: 'ENFORCE',
      current: 'OBSERVE',
      activeRestrictions: { lockdown: true, quarantines: 2, raidSlowmodeChannels: 1 },
    });
    const before = await state();
    expect(before.lockdown).not.toBeNull();
    expect(before.quarantines).toHaveLength(2);
    expect(before.raidResponse?.slowmode).toHaveLength(1);

    // The recovery timer is automatic and must leave every journal untouched.
    vi.setSystemTime(T0 + 30 * MINUTE);
    const calls = world.channel.setRateLimitPerUser.mock.calls.length;
    const edits = world.overwriteManager.edit.mock.calls.length;
    expect(await service.checkRaidRecovery(world.guild)).toBe(false);
    expect(world.channel.setRateLimitPerUser.mock.calls.length).toBe(calls);
    expect(world.overwriteManager.edit.mock.calls.length).toBe(edits);
    expect((await state()).raidResponse).toEqual(before.raidResponse);
    expect((await state()).lockdown).toEqual(before.lockdown);

    // Staff recovery works in every mode.
    const released = await service.runManual(ownerId, () =>
      service.releaseLockdown(world.guild, ownerId),
    );
    expect(released.restored).toBeGreaterThan(0);
    expect((await state()).lockdown).toBeNull();
    for (const record of before.quarantines) {
      const member = world.members.get(record.targetId)!;
      expect(
        await service.runManual(ownerId, () =>
          service.unquarantine(member as unknown as GuildMember, ownerId, 'review done'),
        ),
      ).toBe('UNQUARANTINED');
    }
    expect((await state()).quarantines).toHaveLength(0);

    await configure({ raidMode: 'OFF' });
    expect(await service.runManual(ownerId, () => service.checkRaidRecovery(world.guild))).toBe(
      true,
    );
    expect(world.channel.rateLimitPerUser).toBe(0);
    expect((await state()).raidResponse).toBeNull();
  });

  it('persists the mode across restarts and migrates legacy configuration to OBSERVE', async () => {
    const world = createWorld();
    const first = new SecurityService(store);
    await first.setEnforcementMode(world.guild, 'ENFORCE', ownerId);

    const restartedStore = new JsonDiscordRuntimeStore(storePath);
    expect((await restartedStore.getGuild(guildId)).security.config.enforcementMode).toBe(
      'ENFORCE',
    );
    const second = new SecurityService(restartedStore);
    expect(await second.activateLockdown(world.guild, 'auto', null, true)).toMatch(
      /^LOCKDOWN_ACTIVE:/,
    );

    await second.setEnforcementMode(world.guild, 'OBSERVE', ownerId);
    const third = new SecurityService(new JsonDiscordRuntimeStore(storePath));
    expect(
      await third.quarantine(world.makeMember(actorId) as unknown as GuildMember, 'x', botId),
    ).toBe('ENFORCEMENT_MODE_BLOCKED:OBSERVE');
    expect(DEFAULT_SECURITY_CONFIG.enforcementMode).toBe('OBSERVE');
    expect(
      (await new JsonDiscordRuntimeStore(join(directory, 'fresh.json')).getGuild(guildId)).security
        .config.enforcementMode,
    ).toBe('OBSERVE');
  });

  it('records and posts mode changes in every mode without touching restrictions', async () => {
    const world = createWorld();
    await configure({ channels: { alerts: null, audit: alertsId, modLogs: null } });
    const service = new SecurityService(store);

    const first = await service.setEnforcementMode(world.guild, 'ALERT', ownerId);
    const second = await service.setEnforcementMode(world.guild, 'ALERT', ownerId);

    expect(first.previous).toBe('OBSERVE');
    expect(second).toMatchObject({ previous: 'ALERT', current: 'ALERT' });
    expect(world.alerts.send).toHaveBeenCalledTimes(2);
    const current = await state();
    expect(current.config.enforcementMode).toBe('ALERT');
    expect(current.incidents).toHaveLength(2);
    expect(current.incidents[0]).toMatchObject({
      source: 'SecurityCommand',
      rule: 'ENFORCEMENT_MODE_ALERT',
      automatic: false,
      actorId: ownerId,
    });
    expect(current.incidents[0]?.evidence[0]).toBe('OBSERVE -> ALERT');
    expectNoGuildMutations(world);
  });

  it('always posts manual raid-mode and resolution logs even in OBSERVE', async () => {
    const world = createWorld();
    await configure({ channels: { alerts: alertsId, audit: alertsId, modLogs: null } });
    const service = new SecurityService(store);

    await service.recordManualRaidMode(world.guild, ownerId, 'ON');
    const id = (await state()).incidents[0]?.id ?? '';
    await service.resolveIncident(world.guild, id, ownerId, 'done');

    expect(world.alerts.send).toHaveBeenCalledTimes(2);
  });

  it('lists the automatic responses ENFORCE would activate for the current module configuration', () => {
    const defaults = enforcedProtections(DEFAULT_SECURITY_CONFIG);
    expect(defaults).toContain('Raid slowmode of 30s on configured lockdown channels');
    expect(defaults).toContain('Automatic lockdown on CRITICAL raid or anti-nuke incidents');
    expect(defaults).toContain('Spam message deletion and member timeouts');

    const reduced = enforcedProtections({
      ...DEFAULT_SECURITY_CONFIG,
      raidSlowmodeSeconds: 0,
      modules: {
        ...DEFAULT_SECURITY_CONFIG.modules,
        spam: false,
        antiNuke: false,
        lockdown: false,
      },
    });
    expect(reduced).toContain('Raid slowmode disabled');
    expect(reduced.some((line) => line.startsWith('Spam'))).toBe(false);
    expect(reduced.some((line) => line.startsWith('Anti-nuke'))).toBe(false);
    expect(reduced.some((line) => line.startsWith('Automatic lockdown'))).toBe(false);
    expect(enforcedProtections({ ...DEFAULT_SECURITY_CONFIG, enabled: false })).toEqual([]);
  });

  describe('review regressions', () => {
    const unverifiedEscalation = {
      id: '92345678901234569',
      action: AuditLogEvent.ChannelOverwriteDelete,
      executorId: actorId,
      targetId: channelId,
      createdTimestamp: Date.now(),
      reason: null,
      extra: { id: '92345678901234568' },
      changes: [{ key: 'deny', old: P.ManageChannels.toString(), new: '0' }],
    } as unknown as GuildAuditLogsEntry;

    it.each([
      ['OBSERVE', 0],
      ['ALERT', 1],
    ] as const)(
      'treats unverified permission escalations as automatic in %s mode',
      async (mode, posted) => {
        const world = createWorld();
        await configure({
          enforcementMode: mode,
          channels: { alerts: null, audit: alertsId, modLogs: null },
        });

        await new SecurityService(store).handleAuditEntry(unverifiedEscalation, world.guild);

        const incident = (await state()).incidents.at(-1);
        expect(incident).toMatchObject({
          rule: 'UNVERIFIED_DANGEROUS_DENY_REMOVAL',
          automatic: true,
        });
        expect(world.alerts.send).toHaveBeenCalledTimes(posted);
        expectNoGuildMutations(world);
      },
    );

    it('does not let an unwrapped caller turn a manual-looking public log into an OBSERVE post', async () => {
      const world = createWorld();
      await configure({ channels: { alerts: alertsId, audit: alertsId, modLogs: null } });
      const service = new SecurityService(store);
      const incident = createIncident({
        severity: 'HIGH',
        title: 'Looks manual but is not',
        source: 'PermissionGuard',
        rule: 'TEST',
        actorId: null,
        targetId: null,
        evidence: [],
        automatic: false,
        actionTaken: [],
        auditCorrelation: 'NOT_APPLICABLE',
      });
      const internals = service as unknown as {
        logIncident(guild: Guild, value: typeof incident, destination: 'alerts'): Promise<void>;
      };

      await internals.logIncident(world.guild, incident, 'alerts');
      expect(world.alerts.send).not.toHaveBeenCalled();
      await service.runManual(ownerId, () =>
        internals.logIncident(world.guild, incident, 'alerts'),
      );
      expect(world.alerts.send).toHaveBeenCalledTimes(1);
    });

    const flipOnConfigRead = (service: SecurityService, flipOn: number) => {
      let reads = 0;
      const original = store.getGuild.bind(store);
      vi.spyOn(store, 'getGuild').mockImplementation(async (id: string) => {
        reads += 1;
        if (reads === flipOn) await configure({ enforcementMode: 'OBSERVE' });
        return original(id);
      });
      return service;
    };

    it('re-checks the notification policy right before sending an incident', async () => {
      const world = createWorld();
      await configure({
        enforcementMode: 'ALERT',
        channels: { alerts: alertsId, audit: null, modLogs: null },
      });
      const incident = createIncident({
        severity: 'HIGH',
        title: 'Race',
        source: 'RaidDetector',
        rule: 'RACE',
        actorId: null,
        targetId: null,
        evidence: [],
        automatic: true,
        actionTaken: [],
        auditCorrelation: 'NOT_APPLICABLE',
      });
      const service = flipOnConfigRead(new SecurityService(store), 2);
      const internals = service as unknown as {
        logIncident(guild: Guild, value: typeof incident, destination: 'alerts'): Promise<void>;
      };

      await internals.logIncident(world.guild, incident, 'alerts');

      expect(world.alerts.send).not.toHaveBeenCalled();
    });

    it('re-checks the notification policy right before writing a log embed', async () => {
      const world = createWorld();
      await configure({
        enforcementMode: 'ALERT',
        channels: { alerts: alertsId, audit: null, modLogs: null },
      });
      const service = flipOnConfigRead(new SecurityService(store), 2);
      const internals = service as unknown as {
        writeLog(guild: Guild, key: 'alerts', embed: object): Promise<void>;
      };

      await internals.writeLog(world.guild, 'alerts', {});

      expect(world.alerts.send).not.toHaveBeenCalled();
    });

    const flipWhenApplying = (world: World) => {
      let flipped = false;
      const channels = world.guild.channels as unknown as {
        fetch: (...args: unknown[]) => unknown;
      };
      const original = channels.fetch;
      channels.fetch = vi.fn(async (...args: unknown[]) => {
        const current = await state();
        const applying =
          current.lockdown?.channels.some((entry) =>
            entry.patches?.some((patch) => patch.status === 'APPLYING'),
          ) === true ||
          current.quarantines.some((record) =>
            record.channels.some((entry) => entry.patch.status === 'APPLYING'),
          );
        if (applying && !flipped) {
          flipped = true;
          await configure({ enforcementMode: 'OBSERVE' });
        }
        return original(...args);
      });
    };

    it('leaves a mode-blocked lockdown recoverable instead of marking patches CONFLICT', async () => {
      const world = createWorld();
      await configure({ ...raidConfig, enforcementMode: 'ENFORCE' });
      const service = new SecurityService(store);
      flipWhenApplying(world);

      const blocked = await service.activateLockdown(world.guild, 'auto', 'XEN-SEC-TEST', true);

      expect(blocked).toBe('ENFORCEMENT_MODE_BLOCKED:OBSERVE:PERMISSION_OVERWRITE');
      expect(world.overwriteManager.edit).not.toHaveBeenCalled();
      const journal = (await state()).lockdown;
      const statuses = journal?.channels.flatMap((entry) =>
        (entry.patches ?? []).map((patch) => patch.status),
      );
      expect(statuses).toContain('APPLYING');
      expect(statuses).not.toContain('CONFLICT');

      const released = await service.runManual(ownerId, () =>
        service.releaseLockdown(world.guild, ownerId),
      );
      expect(released.conflicts).toEqual([]);
      expect((await state()).lockdown).toBeNull();
    });

    it('resumes a mode-blocked lockdown manually instead of reporting it already active', async () => {
      const world = createWorld();
      await configure({ ...raidConfig, enforcementMode: 'ENFORCE' });
      const service = new SecurityService(store);
      flipWhenApplying(world);
      await service.activateLockdown(world.guild, 'auto', 'XEN-SEC-TEST', true);

      const resumed = await service.runManual(ownerId, () =>
        service.activateLockdown(world.guild, 'manual', null, false, ownerId),
      );

      expect(resumed).toMatch(/^LOCKDOWN_ACTIVE:/);
      expect(world.overwriteManager.edit).toHaveBeenCalled();
    });

    it('leaves a mode-blocked quarantine resumable by staff', async () => {
      const world = createWorld();
      const member = world.makeMember('92345678901234567') as unknown as GuildMember;
      await configure({ ...raidConfig, enforcementMode: 'ENFORCE' });
      const service = new SecurityService(store);
      flipWhenApplying(world);

      expect(await service.quarantine(member, 'auto', botId)).toBe(
        'ENFORCEMENT_MODE_BLOCKED:OBSERVE:PERMISSION_OVERWRITE',
      );
      expect(world.overwriteManager.edit).not.toHaveBeenCalled();
      expect((await state()).quarantines[0]?.channels[0]?.patch.status).toBe('APPLYING');

      expect(
        await service.runManual(ownerId, () => service.quarantine(member, 'manual', ownerId)),
      ).toMatch(/^QUARANTINED:/);
    });
  });
});
