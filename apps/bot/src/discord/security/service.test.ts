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
import { afterEach, describe, expect, it, vi } from 'vitest';

import { JsonDiscordRuntimeStore } from '../runtime-store';

import { SecurityService } from './service';

const guildId = '12345678901234567';
const ownerId = '22345678901234567';
const channelId = '32345678901234567';
const quarantineId = '42345678901234567';
const actorId = '52345678901234567';

interface TestRole {
  readonly id: string;
  readonly position: number;
}

interface TestOverwrite {
  readonly id: string;
  readonly type: 0 | 1;
  readonly allow: PermissionsBitField;
  readonly deny: PermissionsBitField;
}

interface TestChannel {
  readonly id: string;
  readonly name: string;
  readonly type: ChannelType.GuildText;
  readonly parent: null;
  readonly parentId: null;
  readonly permissionOverwrites: {
    readonly cache: Collection<string, TestOverwrite>;
  };
}

interface TestMember {
  readonly id: string;
  readonly guild: Guild;
  readonly manageable: boolean;
  readonly permissions: PermissionsBitField;
  readonly roles: {
    readonly cache: Collection<string, TestRole>;
    readonly highest: TestRole & {
      comparePositionTo(role: TestRole): number;
    };
    add(role: TestRole, reason?: string): Promise<void>;
    remove(role: TestRole, reason?: string): Promise<void>;
  };
  readonly user: { readonly id: string; readonly bot: boolean; readonly createdTimestamp: number };
  readonly voice: { readonly channelId: string | null };
  permissionsIn(channel: TestChannel): PermissionsBitField;
}

function createGuild(
  botPermissions = P.ViewChannel |
    P.ManageChannels |
    P.ManageRoles |
    P.SendMessages |
    P.SendMessagesInThreads |
    P.CreatePublicThreads |
    P.CreatePrivateThreads |
    P.Connect |
    P.Speak,
) {
  const botId = '62345678901234567';
  const botRoleId = '72345678901234567';
  const everyone = {
    id: guildId,
    name: '@everyone',
    position: 0,
    permissions: new PermissionsBitField(0n),
  };
  const quarantineRole = {
    id: quarantineId,
    name: 'Xenon Quarantine',
    position: 2,
    permissions: new PermissionsBitField(0n),
    managed: false,
  };
  const botRole = {
    id: botRoleId,
    name: 'XenonBot',
    position: 10,
    permissions: new PermissionsBitField(
      P.ManageChannels |
        P.ManageRoles |
        P.SendMessages |
        P.SendMessagesInThreads |
        P.CreatePublicThreads |
        P.CreatePrivateThreads |
        P.Connect |
        P.Speak,
    ),
    managed: false,
  };
  const roleCache = new Collection<string, TestRole>([
    [guildId, everyone],
    [quarantineId, quarantineRole],
    [botRoleId, botRole],
  ]);
  const overwrites = new Collection<string, TestOverwrite>();
  const members = new Collection<string, TestMember>();
  const permissionsIn = (member: TestMember, channel: TestChannel): PermissionsBitField => {
    let bits = member.permissions.bitfield;
    const apply = (current: bigint, overwrite: TestOverwrite): bigint =>
      (current & ~overwrite.deny.bitfield) | overwrite.allow.bitfield;
    const channelOverwrites = channel.permissionOverwrites.cache;
    const everyoneOverwrite = channelOverwrites.get(guildId);
    if (everyoneOverwrite !== undefined) bits = apply(bits, everyoneOverwrite);
    const roleOverwrites = [...channelOverwrites.values()].filter(
      (overwrite) => overwrite.type === 0 && member.roles.cache.has(overwrite.id),
    );
    const roleDenied = roleOverwrites.reduce(
      (value, overwrite) => value | overwrite.deny.bitfield,
      0n,
    );
    const roleAllowed = roleOverwrites.reduce(
      (value, overwrite) => value | overwrite.allow.bitfield,
      0n,
    );
    bits = (bits & ~roleDenied) | roleAllowed;
    const memberOverwrite = channelOverwrites.get(member.id);
    if (memberOverwrite?.type === 1) bits = apply(bits, memberOverwrite);
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
    set: vi.fn((next: readonly { id: string; type: 0 | 1; allow: string; deny: string }[]) => {
      overwrites.clear();
      for (const entry of next)
        overwrites.set(entry.id, {
          id: entry.id,
          type: entry.type,
          allow: new PermissionsBitField(BigInt(entry.allow)),
          deny: new PermissionsBitField(BigInt(entry.deny)),
        });
      return Promise.resolve();
    }),
  };
  const channel: TestChannel = {
    id: channelId,
    name: 'general',
    type: ChannelType.GuildText,
    parent: null,
    parentId: null,
    permissionOverwrites: overwriteManager,
  };
  const memberManager = {
    cache: members,
    fetch: vi.fn((input: string | { readonly user: string }) => {
      const id = typeof input === 'string' ? input : input.user;
      const member = members.get(id);
      if (member === undefined) return Promise.reject(new Error(`Missing test member ${id}`));
      return Promise.resolve(member);
    }),
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
      cache: new Collection<string, TestChannel>([[channelId, channel]]),
      fetch: vi.fn((id: string) => Promise.resolve(id === channelId ? channel : null)),
    },
    members: memberManager,
    client: { user: { id: botId } },
  } as unknown as Guild;
  const makeMember = (
    id: string,
    roleIds: readonly string[] = [],
    options: {
      readonly permissions?: bigint;
      readonly highestPosition?: number;
      readonly bot?: boolean;
    } = {},
  ): TestMember => {
    const roleMemberCache = new Collection<string, TestRole>(
      roleIds.map((roleId) => [roleId, roleCache.get(roleId) ?? { id: roleId, position: 1 }]),
    );
    const highestPosition = options.highestPosition ?? 1;
    const member: TestMember = {
      id,
      guild,
      manageable: true,
      permissions: new PermissionsBitField(options.permissions ?? 0n),
      roles: {
        cache: roleMemberCache,
        highest: {
          id: `test-role-${id}`,
          position: highestPosition,
          comparePositionTo: (role) => highestPosition - role.position,
        },
        add: (role) => {
          roleMemberCache.set(role.id, role);
          return Promise.resolve();
        },
        remove: (role) => {
          roleMemberCache.delete(role.id);
          return Promise.resolve();
        },
      },
      user: { id, bot: options.bot ?? false, createdTimestamp: Date.now() },
      voice: { channelId: null },
      permissionsIn: (target) => permissionsIn(member, target),
    };
    members.set(id, member);
    return member;
  };
  const bot = makeMember(botId, [botRoleId], {
    permissions: botPermissions,
    highestPosition: 10,
    bot: true,
  });
  Object.defineProperty(memberManager, 'me', { value: bot });
  return { guild, channel, overwriteManager, quarantineRole, members, makeMember };
}

describe('security containment services', () => {
  let directory = '';

  afterEach(async () => {
    if (directory !== '') await rm(directory, { recursive: true, force: true });
    directory = '';
  });

  it('restores lockdown-owned permission bits and preserves unrelated overwrite changes', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-lockdown-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = createGuild();
    await store.updateGuild(guildId, (current) => ({
      ...current,
      security: {
        ...current.security,
        config: { ...current.security.config, lockdownChannelIds: [channelId] },
      },
    }));
    const service = new SecurityService(store);

    const result = await service.activateLockdown(
      fake.guild,
      'Raid response',
      null,
      false,
      ownerId,
    );
    expect(result).toContain('1/1');
    expect((await store.getGuild(guildId)).security.lockdown?.channels[0]?.overwrites).toEqual([]);
    const incident = (await store.getGuild(guildId)).security.incidents.find(
      (record) => record.rule === 'MANUAL_LOCKDOWN',
    );
    expect(incident).toMatchObject({
      status: 'CONTAINED',
      actionTaken: ['Lockdown snapshot captured before channel changes', 'LOCKDOWN_ACTIVE:1/1'],
    });
    expect(fake.overwriteManager.cache.get(guildId)?.deny.bitfield).toBe(
      P.SendMessages | P.SendMessagesInThreads | P.CreatePublicThreads | P.CreatePrivateThreads,
    );

    const released = await service.releaseLockdown(fake.guild, ownerId);
    expect(released).toEqual({ restored: 1, conflicts: [] });
    expect(
      (fake.overwriteManager.cache.get(guildId)?.deny.bitfield ?? 0n) &
        (P.SendMessages | P.SendMessagesInThreads | P.CreatePublicThreads | P.CreatePrivateThreads),
    ).toBe(0n);
    const state = (await store.getGuild(guildId)).security;
    expect(state.lockdown).toBeNull();
    expect(state.incidents.at(-1)).toMatchObject({
      source: 'LockdownService',
      status: 'RESOLVED',
      actorId: ownerId,
    });
  });

  it('restores only Xenon-owned lockdown bits after unrelated permission edits', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-lockdown-conflict-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = createGuild();
    await store.updateGuild(guildId, (current) => ({
      ...current,
      security: {
        ...current.security,
        config: { ...current.security.config, lockdownChannelIds: [channelId] },
      },
    }));
    const service = new SecurityService(store);
    await service.activateLockdown(fake.guild, 'Raid response', null, false, ownerId);
    const current = fake.overwriteManager.cache.get(guildId)!;
    fake.overwriteManager.cache.set(guildId, {
      ...current,
      allow: new PermissionsBitField(current.allow.bitfield | P.ManageMessages),
      deny: current.deny,
    });

    const released = await service.releaseLockdown(fake.guild, ownerId);
    expect(released).toEqual({ restored: 1, conflicts: [] });
    expect(fake.overwriteManager.cache.get(guildId)?.allow.has(P.ManageMessages)).toBe(true);
    expect(fake.overwriteManager.set).not.toHaveBeenCalled();
  });

  it('never locks a configured security log channel even when listed as a lockdown target', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-lockdown-log-channel-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = createGuild();
    await store.updateGuild(guildId, (current) => ({
      ...current,
      security: {
        ...current.security,
        config: {
          ...current.security.config,
          channels: { ...current.security.config.channels, alerts: channelId },
          lockdownChannelIds: [channelId],
        },
      },
    }));
    const result = await new SecurityService(store).activateLockdown(
      fake.guild,
      'Raid response',
      null,
      false,
      ownerId,
    );
    expect(result).toBe('LOCKDOWN_NO_PUBLIC_CHANNELS');
    expect(fake.overwriteManager.edit).not.toHaveBeenCalled();
    expect((await store.getGuild(guildId)).security.lockdown).toBeNull();
  });

  it('keeps link protection active for roles exempted only from custom spam scanning', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-spam-exemption-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = createGuild();
    const exemptRoleId = '72345678901234567';
    await store.updateGuild(guildId, (current) => ({
      ...current,
      security: {
        ...current.security,
        config: {
          ...current.security.config,
          spam: { ...current.security.config.spam, exemptRoleIds: [exemptRoleId] },
          links: {
            ...current.security.config.links,
            action: 'BLOCK',
            blockedDomains: ['bad.example'],
          },
        },
      },
    }));
    const member = {
      id: actorId,
      guild: fake.guild,
      roles: { cache: new Collection([[exemptRoleId, { id: exemptRoleId }]]) },
    } as unknown as GuildMember;
    const message = {
      id: '82345678901234567',
      guild: fake.guild,
      guildId,
      channelId,
      author: { bot: false },
      webhookId: null,
      content:
        'https://safe.example/1 https://safe.example/2 https://safe.example/3 https://safe.example/4 https://safe.example/5 https://bad.example/phishing',
      createdTimestamp: Date.now(),
      member,
      mentions: { users: new Collection(), roles: new Collection(), everyone: false },
      inGuild: () => true,
      delete: vi.fn(() => Promise.resolve()),
    } as unknown as Message;
    const service = new SecurityService(store);
    service.setMessageContentAvailable(true);

    await service.handleMessage(message);
    expect(message.delete).toHaveBeenCalledOnce();
    expect((await store.getGuild(guildId)).security.incidents.at(-1)?.rule).toBe('LINK_BLOCK');
  });

  it('exempts configured channels from custom spam scanning', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-channel-spam-exemption-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = createGuild();
    await store.updateGuild(guildId, (current) => ({
      ...current,
      security: {
        ...current.security,
        config: {
          ...current.security.config,
          spam: { ...current.security.config.spam, exemptChannelIds: [channelId] },
        },
      },
    }));
    const member = {
      id: actorId,
      guild: fake.guild,
      roles: { cache: new Collection() },
    } as unknown as GuildMember;
    const message = {
      id: '82345678901234567',
      guild: fake.guild,
      guildId,
      channelId,
      author: { bot: false },
      webhookId: null,
      content: 'Repeated message',
      createdTimestamp: Date.now(),
      member,
      mentions: { users: new Collection(), roles: new Collection(), everyone: false },
      inGuild: () => true,
      delete: vi.fn(() => Promise.resolve()),
    } as unknown as Message;
    const service = new SecurityService(store);
    service.setMessageContentAvailable(true);
    for (let count = 0; count < 10; count += 1) await service.handleMessage(message);
    expect(message.delete).not.toHaveBeenCalled();
    expect((await store.getGuild(guildId)).security.incidents).toHaveLength(0);
  });

  it('implicitly exempts the guild owner from custom content guards', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-owner-content-exemption-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = createGuild();
    await store.updateGuild(guildId, (current) => ({
      ...current,
      security: {
        ...current.security,
        config: {
          ...current.security.config,
          links: {
            ...current.security.config.links,
            action: 'BLOCK',
            blockedDomains: ['bad.example'],
          },
        },
      },
    }));
    const member = {
      id: ownerId,
      guild: fake.guild,
      roles: { cache: new Collection() },
    } as unknown as GuildMember;
    const message = {
      id: '82345678901234567',
      guild: fake.guild,
      guildId,
      channelId,
      author: { bot: false },
      webhookId: null,
      content: 'https://bad.example/phishing',
      createdTimestamp: Date.now(),
      member,
      mentions: { users: new Collection(), roles: new Collection(), everyone: false },
      inGuild: () => true,
      delete: vi.fn(() => Promise.resolve()),
    } as unknown as Message;
    const service = new SecurityService(store);
    service.setMessageContentAvailable(true);
    await service.handleMessage(message);
    expect(message.delete).not.toHaveBeenCalled();
    expect((await store.getGuild(guildId)).security.incidents).toHaveLength(0);
  });

  it('uses member-specific denies to quarantine through role-level allows and restores safely', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-quarantine-case-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = createGuild();
    await store.updateGuild(guildId, (current) => ({
      ...current,
      security: {
        ...current.security,
        config: { ...current.security.config, quarantineRoleId: quarantineId },
      },
    }));
    const allowedRoleId = '82345678901234567';
    fake.overwriteManager.cache.set(allowedRoleId, {
      id: allowedRoleId,
      type: 0,
      allow: new PermissionsBitField(P.ViewChannel | P.SendMessages),
      deny: new PermissionsBitField(0n),
    });
    const testMember = fake.makeMember(actorId, [allowedRoleId]);
    const member = testMember as unknown as GuildMember;
    expect(testMember.permissionsIn(fake.channel).has(P.ViewChannel)).toBe(true);
    const service = new SecurityService(store);

    expect(await service.quarantine(member, 'Review required', ownerId)).toMatch(
      /^QUARANTINED:XEN-MOD-/,
    );
    expect(testMember.permissionsIn(fake.channel).has(P.ViewChannel)).toBe(false);
    expect(fake.overwriteManager.cache.get(actorId)?.deny.has(P.ViewChannel)).toBe(true);
    expect(testMember.roles.cache.has(quarantineId)).toBe(true);
    expect((await store.getGuild(guildId)).security.quarantines[0]?.markerRoleAdded).toBe(true);
    const quarantineCase = (await store.getGuild(guildId)).security.cases[0];
    expect(quarantineCase).toMatchObject({ action: 'QUARANTINE', moderatorId: ownerId });

    expect(await service.unquarantine(member, ownerId, 'Review complete')).toBe('UNQUARANTINED');
    expect(testMember.permissionsIn(fake.channel).has(P.ViewChannel)).toBe(true);
    expect(testMember.roles.cache.has(quarantineId)).toBe(false);
    expect((await store.getGuild(guildId)).security.cases.map((record) => record.action)).toEqual([
      'QUARANTINE',
      'UNQUARANTINE',
    ]);
  });

  it('preserves a quarantine marker role that Xenon did not add', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-quarantine-existing-marker-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = createGuild();
    await store.updateGuild(guildId, (current) => ({
      ...current,
      security: {
        ...current.security,
        config: { ...current.security.config, quarantineRoleId: quarantineId },
      },
    }));
    const member = fake.makeMember(actorId, [quarantineId]);
    const service = new SecurityService(store);

    expect(
      await service.quarantine(member as unknown as GuildMember, 'Review required', ownerId),
    ).toMatch(/^QUARANTINED:XEN-MOD-/);
    expect((await store.getGuild(guildId)).security.quarantines[0]?.markerRoleAdded).toBe(false);
    expect(
      await service.unquarantine(member as unknown as GuildMember, ownerId, 'Review complete'),
    ).toBe('UNQUARANTINED');
    expect(member.roles.cache.has(quarantineId)).toBe(true);
  });

  it('requires Manage Roles for channel overwrite containment', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-overwrite-permissions-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const botPermissions =
      P.ViewChannel |
      P.ManageChannels |
      P.SendMessages |
      P.SendMessagesInThreads |
      P.CreatePublicThreads |
      P.CreatePrivateThreads |
      P.Connect |
      P.Speak;
    const fake = createGuild(botPermissions);
    const service = new SecurityService(store);

    expect(
      await service.activateLockdown(fake.guild, 'Permission check', null, false, ownerId),
    ).toBe('LOCKDOWN_MISSING_MANAGE_ROLES');
    expect(
      await service.quarantine(
        fake.makeMember(actorId) as unknown as GuildMember,
        'Reason',
        ownerId,
      ),
    ).toBe('QUARANTINE_MISSING_MANAGE_ROLES');
    expect(fake.overwriteManager.edit).not.toHaveBeenCalled();
  });

  it('reports missing lockdown permission authority per target channel', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-lockdown-bit-authority-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    await store.updateGuild(guildId, (current) => ({
      ...current,
      security: {
        ...current.security,
        config: { ...current.security.config, lockdownChannelIds: [channelId] },
      },
    }));
    const botPermissions =
      P.ViewChannel |
      P.ManageChannels |
      P.ManageRoles |
      P.SendMessages |
      P.SendMessagesInThreads |
      P.CreatePublicThreads |
      P.Connect |
      P.Speak;
    const fake = createGuild(botPermissions);

    const result = await new SecurityService(store).activateLockdown(
      fake.guild,
      'Permission check',
      null,
      false,
      ownerId,
    );

    expect(result).toContain('LOCKDOWN_PARTIAL:0/1');
    expect(result).toContain('CreatePrivateThreads');
    expect(fake.overwriteManager.edit).not.toHaveBeenCalled();
  });

  it('requires a non-owner moderator to strictly outrank the quarantine target', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-quarantine-hierarchy-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = createGuild();
    const moderatorId = '92345678901234567';
    const moderator = fake.makeMember(moderatorId, [], { highestPosition: 3 });
    const target = fake.makeMember(actorId, [], { highestPosition: 3 });

    const result = await new SecurityService(store).quarantine(
      target as unknown as GuildMember,
      'Suspicious join',
      moderator.id,
    );
    expect(result).toBe('PROTECTION_BLOCKED_BY_MODERATOR_HIERARCHY');
    expect((await store.getGuild(guildId)).security.quarantines).toHaveLength(0);
  });

  it('rejects guild owners and Administrator members as quarantine targets', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-quarantine-admin-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = createGuild();
    const administrator = fake.makeMember(actorId, [], { permissions: P.Administrator });

    const result = await new SecurityService(store).quarantine(
      administrator as unknown as GuildMember,
      'Suspicious join',
      ownerId,
    );
    expect(result).toBe('QUARANTINE_ADMINISTRATOR_TARGET_UNSUPPORTED');
    expect((await store.getGuild(guildId)).security.quarantines).toHaveLength(0);
  });
  it('quarantines untrusted arrivals in manual raid mode while exempting the owner', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-manual-raid-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = createGuild();
    await store.updateGuild(guildId, (current) => ({
      ...current,
      security: { ...current.security, config: { ...current.security.config, raidMode: 'ON' } },
    }));
    const member = fake.makeMember(actorId);
    const owner = fake.makeMember(ownerId, [], { permissions: P.ViewChannel });
    const service = new SecurityService(store);
    await service.handleJoin(member as unknown as GuildMember);
    await service.handleJoin(owner as unknown as GuildMember);

    const state = (await store.getGuild(guildId)).security;
    expect(state.quarantines.map((record) => record.targetId)).toEqual([actorId]);
    expect(state.quarantines[0]?.status).toBe('ACTIVE');
    expect(member.permissionsIn(fake.channel).has(P.ViewChannel)).toBe(false);
    expect(owner.permissionsIn(fake.channel).has(P.ViewChannel)).toBe(true);
    expect(state.incidents).toHaveLength(0);
  });

  it('quarantines every join while raid severity remains elevated', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-sustained-raid-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = createGuild();
    await store.updateGuild(guildId, (current) => ({
      ...current,
      security: {
        ...current.security,
        config: {
          ...current.security.config,
          raidThresholds: {
            warning10s: 1,
            raid10s: 2,
            critical10s: 10,
            warning30s: 1,
            raid30s: 2,
            critical30s: 10,
            newAccountRatio: 1,
          },
          autoLockdownOnCritical: false,
        },
      },
    }));
    const members = [
      fake.makeMember('12345678901234001'),
      fake.makeMember('12345678901234002'),
      fake.makeMember('12345678901234003'),
    ];
    const service = new SecurityService(store);
    for (const member of members) await service.handleJoin(member as unknown as GuildMember);

    const state = (await store.getGuild(guildId)).security;
    expect(state.quarantines.map((record) => record.targetId)).toEqual([
      members[1]?.id,
      members[2]?.id,
    ]);
    expect(members[1]?.permissionsIn(fake.channel).has(P.ViewChannel)).toBe(false);
    expect(members[2]?.permissionsIn(fake.channel).has(P.ViewChannel)).toBe(false);
    expect(state.incidents.filter((incident) => incident.rule === 'JOIN_WINDOW_RAID')).toHaveLength(
      1,
    );
  });
  it('bounds Discord audit reasons before persisting anti-nuke evidence', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-audit-reason-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = createGuild();
    const service = new SecurityService(store);
    const reason = 'R'.repeat(512);
    const makeEntry = (targetId: string) =>
      ({
        id: targetId,
        action: AuditLogEvent.ChannelDelete,
        executorId: actorId,
        targetId,
        createdTimestamp: Date.now(),
        reason,
        changes: [],
        extra: null,
      }) as unknown as GuildAuditLogsEntry;

    await service.handleAuditEntry(makeEntry(channelId), fake.guild);
    await service.handleAuditEntry(makeEntry('32345678901234568'), fake.guild);

    const incident = (await store.getGuild(guildId)).security.incidents.at(-1);
    const auditReason = incident?.evidence.find((item) => item.startsWith('Audit reason:'));
    expect(auditReason).toHaveLength('Audit reason: '.length + 480);
  });

  it('does not feed a repeated audit entry into the anti-nuke detector twice', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-audit-deduplication-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = createGuild();
    const service = new SecurityService(store);
    const makeEntry = (id: string, targetId: string) =>
      ({
        id,
        action: AuditLogEvent.ChannelDelete,
        executorId: actorId,
        targetId,
        createdTimestamp: Date.now(),
        reason: null,
        changes: [],
        extra: null,
      }) as unknown as GuildAuditLogsEntry;
    const first = makeEntry('92345678901234570', channelId);

    await service.handleAuditEntry(first, fake.guild);
    await service.handleAuditEntry(first, fake.guild);
    await service.handleAuditEntry(makeEntry('92345678901234571', '32345678901234568'), fake.guild);

    const incidents = (await store.getGuild(guildId)).security.incidents;
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.evidence[0]).toBe('2 matching actions within the configured window');
  });

  it('retries failed incident persistence without recounting its audit event', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-audit-retry-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = createGuild();
    const service = new SecurityService(store);
    const makeEntry = (id: string, targetId: string) =>
      ({
        id,
        action: AuditLogEvent.ChannelDelete,
        executorId: actorId,
        targetId,
        createdTimestamp: Date.now(),
        reason: null,
        changes: [],
        extra: null,
      }) as unknown as GuildAuditLogsEntry;
    const first = makeEntry('92345678901234572', channelId);
    const second = makeEntry('92345678901234573', '32345678901234568');
    await service.handleAuditEntry(first, fake.guild);
    vi.spyOn(store, 'updateGuild').mockRejectedValueOnce(
      new Error('temporary persistence failure'),
    );

    await expect(service.handleAuditEntry(second, fake.guild)).rejects.toThrow(
      'temporary persistence failure',
    );
    await service.handleAuditEntry(second, fake.guild);

    const incident = (await store.getGuild(guildId)).security.incidents[0];
    expect(incident?.severity).toBe('HIGH');
    expect(incident?.evidence[0]).toBe('2 matching actions within the configured window');
  });

  it('classifies dangerous permission deny removal when the overwrite subject has a base grant', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-audit-deny-removal-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = createGuild();
    fake.makeMember('92345678901234568', [], { permissions: P.ManageChannels });
    const entry = {
      id: '92345678901234569',
      action: AuditLogEvent.ChannelOverwriteUpdate,
      executorId: actorId,
      targetId: channelId,
      createdTimestamp: Date.now(),
      reason: null,
      extra: { id: '92345678901234568' },
      changes: [{ key: 'deny', old: P.ManageChannels.toString(), new: '0' }],
    } as unknown as GuildAuditLogsEntry;

    await new SecurityService(store).handleAuditEntry(entry, fake.guild);

    const incident = (await store.getGuild(guildId)).security.incidents.at(-1);
    expect(incident?.rule).toBe('GUILD_PERMISSION_CHANGE_1_IN_60000MS');
    expect(incident?.evidence.some((item) => item.includes('effective base grant'))).toBe(true);
  });

  it('reports unverified dangerous permission deny removals without silent acceptance', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-audit-deny-unknown-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = createGuild();
    const entry = {
      id: '92345678901234569',
      action: AuditLogEvent.ChannelOverwriteDelete,
      executorId: actorId,
      targetId: channelId,
      createdTimestamp: Date.now(),
      reason: null,
      extra: { id: '92345678901234568' },
      changes: [{ key: 'deny', old: P.ManageChannels.toString(), new: '0' }],
    } as unknown as GuildAuditLogsEntry;

    await new SecurityService(store).handleAuditEntry(entry, fake.guild);

    expect((await store.getGuild(guildId)).security.incidents.at(-1)).toMatchObject({
      source: 'PermissionGuard',
      rule: 'UNVERIFIED_DANGEROUS_DENY_REMOVAL',
      severity: 'MEDIUM',
    });
  });

  it('keeps an interrupted lockdown partial when an intended channel was never protectable', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-lockdown-resume-partial-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = createGuild();
    await store.updateGuild(guildId, (current) => ({
      ...current,
      security: {
        ...current.security,
        config: {
          ...current.security.config,
          lockdownChannelIds: [channelId, '32345678901234999'],
        },
      },
    }));
    const service = new SecurityService(store);
    expect(
      await service.activateLockdown(fake.guild, 'Raid response', null, false, ownerId),
    ).toMatch(/^LOCKDOWN_PARTIAL:1\/2/);
    await markJournalStatus(store, 'APPLYING');
    fake.overwriteManager.cache.clear();

    expect(
      await service.activateLockdown(fake.guild, 'Raid response', null, false, ownerId),
    ).toMatch(/^LOCKDOWN_PARTIAL:1\/2/);
    const incident = (await store.getGuild(guildId)).security.incidents.find(
      (record) => record.rule === 'MANUAL_LOCKDOWN',
    );
    expect(incident?.status).toBe('OPEN');
  });

  async function enableQuarantineMarker(store: JsonDiscordRuntimeStore): Promise<void> {
    await store.updateGuild(guildId, (current) => ({
      ...current,
      security: {
        ...current.security,
        config: { ...current.security.config, quarantineRoleId: quarantineId },
      },
    }));
  }

  async function markJournalStatus(
    store: JsonDiscordRuntimeStore,
    status: 'APPLYING' | 'RESTORING',
  ): Promise<void> {
    await store.updateGuild(guildId, (current) => ({
      ...current,
      security: {
        ...current.security,
        lockdown:
          current.security.lockdown === null
            ? null
            : {
                ...current.security.lockdown,
                channels: current.security.lockdown.channels.map((channel) => ({
                  ...channel,
                  patches: channel.patches?.map((patch) => ({ ...patch, status })),
                })),
              },
        quarantines: current.security.quarantines.map((record) => ({
          ...record,
          status: status === 'APPLYING' ? 'APPLYING' : 'RESTORING',
          channels: record.channels.map((channel) => ({
            ...channel,
            patch: { ...channel.patch, status },
          })),
        })),
      },
    }));
  }

  it('never assigns a quarantine marker role that grants permissions', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-marker-permissions-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = createGuild();
    await enableQuarantineMarker(store);
    fake.quarantineRole.permissions = new PermissionsBitField(P.ManageMessages);
    const member = fake.makeMember(actorId);

    const result = await new SecurityService(store).quarantine(
      member as unknown as GuildMember,
      'Review required',
      ownerId,
    );

    expect(result).toMatch(/^QUARANTINED:XEN-MOD-\S+ QUARANTINE_MARKER_HAS_PERMISSIONS/);
    expect(member.roles.cache.has(quarantineId)).toBe(false);
    expect((await store.getGuild(guildId)).security.quarantines[0]?.markerRoleAdded).toBe(false);
  });

  it('refuses to quarantine a member the bot cannot manage before changing anything', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-quarantine-bot-hierarchy-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = createGuild();
    const target = fake.makeMember(actorId);
    Object.defineProperty(target, 'manageable', { value: false });

    const result = await new SecurityService(store).quarantine(
      target as unknown as GuildMember,
      'Suspicious join',
      ownerId,
    );

    expect(result).toBe('PROTECTION_BLOCKED_BY_ROLE_HIERARCHY');
    expect((await store.getGuild(guildId)).security.quarantines).toHaveLength(0);
    expect(fake.overwriteManager.edit).not.toHaveBeenCalled();
  });

  it('does not quarantine through configured security log channels', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-quarantine-log-channel-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = createGuild();
    await store.updateGuild(guildId, (current) => ({
      ...current,
      security: {
        ...current.security,
        config: {
          ...current.security.config,
          channels: { alerts: channelId, audit: null, modLogs: null },
        },
      },
    }));
    const member = fake.makeMember(actorId);

    const result = await new SecurityService(store).quarantine(
      member as unknown as GuildMember,
      'Suspicious join',
      ownerId,
    );

    expect(result).toBe('QUARANTINE_NO_COMMUNICATION_CHANNELS');
    expect(fake.overwriteManager.edit).not.toHaveBeenCalled();
  });

  it('treats a deny removal as an escalation only when it is effective in that channel', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-audit-deny-channel-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = createGuild();
    fake.makeMember('92345678901234568', [], { permissions: P.ManageChannels });
    // Another overwrite in the same channel still denies Manage Channels to everyone.
    fake.overwriteManager.cache.set(guildId, {
      id: guildId,
      type: 0,
      allow: new PermissionsBitField(0n),
      deny: new PermissionsBitField(P.ManageChannels),
    });
    const entry = {
      id: '92345678901234569',
      action: AuditLogEvent.ChannelOverwriteUpdate,
      executorId: actorId,
      targetId: channelId,
      createdTimestamp: Date.now(),
      reason: null,
      extra: { id: '92345678901234568' },
      changes: [{ key: 'deny', old: P.ManageChannels.toString(), new: '0' }],
    } as unknown as GuildAuditLogsEntry;

    await new SecurityService(store).handleAuditEntry(entry, fake.guild);

    expect((await store.getGuild(guildId)).security.incidents).toHaveLength(0);
  });

  it('does not raise a second incident when an old audit entry is replayed after the cooldown', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-audit-replay-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = createGuild();
    const service = new SecurityService(store);
    const makeEntry = (id: string, targetId: string) =>
      ({
        id,
        action: AuditLogEvent.ChannelDelete,
        executorId: actorId,
        targetId,
        createdTimestamp: Date.now(),
        reason: null,
        changes: [],
        extra: null,
      }) as unknown as GuildAuditLogsEntry;
    const first = makeEntry('92345678901234580', channelId);
    const second = makeEntry('92345678901234581', '32345678901234568');
    await service.handleAuditEntry(first, fake.guild);
    await service.handleAuditEntry(second, fake.guild);
    expect((await store.getGuild(guildId)).security.incidents).toHaveLength(1);

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 60_000);
      await service.handleAuditEntry(second, fake.guild);
    } finally {
      vi.useRealTimers();
    }

    expect((await store.getGuild(guildId)).security.incidents).toHaveLength(1);
  });

  it('reconciles an interrupted lockdown journal against live bits when releasing', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-lockdown-interrupted-release-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = createGuild();
    await store.updateGuild(guildId, (current) => ({
      ...current,
      security: {
        ...current.security,
        config: { ...current.security.config, lockdownChannelIds: [channelId] },
      },
    }));
    const service = new SecurityService(store);
    await service.activateLockdown(fake.guild, 'Raid response', null, false, ownerId);
    await markJournalStatus(store, 'APPLYING');

    expect(await service.releaseLockdown(fake.guild, ownerId)).toEqual({
      restored: 1,
      conflicts: [],
    });
    expect((await store.getGuild(guildId)).security.lockdown).toBeNull();
    expect((fake.overwriteManager.cache.get(guildId)?.deny.bitfield ?? 0n) & P.SendMessages).toBe(
      0n,
    );
  });

  it('resumes an interrupted lockdown instead of reporting it already active', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-lockdown-resume-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = createGuild();
    await store.updateGuild(guildId, (current) => ({
      ...current,
      security: {
        ...current.security,
        config: { ...current.security.config, lockdownChannelIds: [channelId] },
      },
    }));
    const service = new SecurityService(store);
    await service.activateLockdown(fake.guild, 'Raid response', null, false, ownerId);
    // Simulate a crash before any overwrite was written.
    await markJournalStatus(store, 'APPLYING');
    fake.overwriteManager.cache.clear();

    expect(await service.activateLockdown(fake.guild, 'Raid response', null, false, ownerId)).toBe(
      'LOCKDOWN_ACTIVE:1/1',
    );
    expect(fake.overwriteManager.cache.get(guildId)?.deny.has(P.SendMessages)).toBe(true);
  });

  it('resumes an interrupted quarantine and restores an interrupted unquarantine', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-quarantine-interrupted-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = createGuild();
    const allowedRoleId = '82345678901234567';
    fake.overwriteManager.cache.set(allowedRoleId, {
      id: allowedRoleId,
      type: 0,
      allow: new PermissionsBitField(P.ViewChannel | P.SendMessages),
      deny: new PermissionsBitField(0n),
    });
    const testMember = fake.makeMember(actorId, [allowedRoleId]);
    const member = testMember as unknown as GuildMember;
    const service = new SecurityService(store);
    expect(await service.quarantine(member, 'Review required', ownerId)).toMatch(/^QUARANTINED:/);

    // Crash after the overwrite was written but before the journal recorded it.
    await markJournalStatus(store, 'APPLYING');
    expect(await service.quarantine(member, 'Review required', ownerId)).toMatch(/^QUARANTINED:/);
    expect((await store.getGuild(guildId)).security.quarantines[0]?.status).toBe('ACTIVE');
    expect(testMember.permissionsIn(fake.channel).has(P.ViewChannel)).toBe(false);

    // Crash during unquarantine after the overwrite was already restored.
    fake.overwriteManager.cache.delete(actorId);
    await markJournalStatus(store, 'RESTORING');
    expect(await service.unquarantine(member, ownerId, 'Review complete')).toBe('UNQUARANTINED');
    expect((await store.getGuild(guildId)).security.quarantines).toHaveLength(0);
    expect(testMember.permissionsIn(fake.channel).has(P.ViewChannel)).toBe(true);
  });
});
