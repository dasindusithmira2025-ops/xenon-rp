import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PermissionFlagsBits as P, type Guild } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { JsonDiscordRuntimeStore } from '../runtime-store';

import { DEFAULT_SECURITY_CONFIG, type GuildSecuritySnapshot } from './model';
import {
  compareSnapshot,
  planRestore,
  restoreRolePermissions,
  type CurrentGuildFacts,
} from './snapshot';

import type { SecurityService } from './service';

const guildId = '12345678901234567';
const actorId = '32345678901234567';
const roleA = '50000000000000001';
const roleB = '50000000000000002';
const roleManaged = '50000000000000003';
const roleHigh = '50000000000000004';
const roleUngrantable = '50000000000000005';
const channelA = '60000000000000001';

const snapshot: GuildSecuritySnapshot = {
  createdAt: '2026-01-01T00:00:00.000Z',
  roles: [
    { id: roleA, name: 'Mod', permissions: String(P.KickMembers), position: 3 },
    { id: roleB, name: 'Deleted', permissions: String(P.ManageMessages), position: 2 },
    { id: roleManaged, name: 'Integration', permissions: '0', position: 2 },
    { id: roleHigh, name: 'Above', permissions: '0', position: 20 },
    { id: roleUngrantable, name: 'Needs', permissions: String(P.ManageGuild), position: 4 },
  ],
  channels: [
    {
      id: channelA,
      name: 'staff',
      type: 0,
      parentId: null,
      overwrites: [{ id: roleA, type: 0, allow: String(P.ViewChannel), deny: '0' }],
    },
    { id: '60000000000000002', name: 'gone', type: 0, parentId: null, overwrites: [] },
  ],
  config: DEFAULT_SECURITY_CONFIG,
};

const current: CurrentGuildFacts = {
  roles: [
    {
      id: roleA,
      name: 'Mod',
      permissions: String(P.KickMembers | P.BanMembers),
      position: 3,
      managed: false,
    },
    {
      id: roleManaged,
      name: 'Integration',
      permissions: String(P.ManageRoles),
      position: 2,
      managed: true,
    },
    {
      id: roleHigh,
      name: 'Above',
      permissions: String(P.ManageChannels),
      position: 20,
      managed: false,
    },
    { id: roleUngrantable, name: 'Needs', permissions: '0', position: 4, managed: false },
    {
      id: '50000000000000009',
      name: 'Evil',
      permissions: String(P.Administrator),
      position: 1,
      managed: false,
    },
    {
      id: '50000000000000010',
      name: 'Harmless',
      permissions: String(P.ViewChannel),
      position: 1,
      managed: false,
    },
  ],
  channels: [
    {
      id: channelA,
      name: 'staff',
      type: 0,
      parentId: null,
      overwrites: [
        { id: roleA, type: 0, allow: String(P.ViewChannel | P.SendMessages), deny: '0' },
        { id: guildId, type: 0, allow: '0', deny: String(P.ViewChannel) },
      ],
    },
  ],
};

describe('compareSnapshot', () => {
  const result = compareSnapshot(snapshot, current);

  it('reports deleted roles and channels with their former details', () => {
    expect(result.deletedRoles).toEqual([
      { id: roleB, name: 'Deleted', permissions: ['ManageMessages'] },
    ]);
    expect(result.deletedChannels.map((channel) => channel.name)).toEqual(['gone']);
  });

  it('reports added and removed permission names for changed roles', () => {
    const mod = result.changedRoles.find((role) => role.id === roleA);
    expect(mod).toMatchObject({ added: ['BanMembers'], removed: [] });
    const needs = result.changedRoles.find((role) => role.id === roleUngrantable);
    expect(needs).toMatchObject({ added: [], removed: ['ManageGuild'] });
  });

  it('reports added and changed channel overwrites', () => {
    expect(result.changedChannels).toHaveLength(1);
    expect(result.changedChannels[0]?.addedOverwrites).toHaveLength(1);
    expect(result.changedChannels[0]?.changedOverwrites).toHaveLength(1);
    expect(result.changedChannels[0]?.removedOverwrites).toHaveLength(0);
  });

  it('flags only new roles that hold dangerous permissions', () => {
    expect(result.newDangerousRoles.map((role) => role.name)).toEqual(['Evil']);
  });

  it('reports no differences for an identical state', () => {
    const same = compareSnapshot(snapshot, {
      roles: snapshot.roles.map((role) => ({ ...role, managed: false })),
      channels: snapshot.channels,
    });
    expect(same).toEqual({
      deletedRoles: [],
      deletedChannels: [],
      changedRoles: [],
      changedChannels: [],
      newDangerousRoles: [],
    });
  });
});

describe('planRestore', () => {
  const bot = { highestPosition: 10, permissions: P.ManageRoles | P.KickMembers | P.BanMembers };

  it('plans only eligible roles and skips managed, above-bot, and ungrantable ones', () => {
    const plan = planRestore(snapshot, current, bot);
    expect(plan.changes.map((change) => change.roleId)).toEqual([roleA]);
    expect(plan.changes[0]).toMatchObject({ added: [], removed: ['BanMembers'] });
    const reasons = Object.fromEntries(plan.skipped.map((skip) => [skip.roleId, skip.reason]));
    expect(reasons[roleManaged]).toContain('managed');
    expect(reasons[roleHigh]).toContain('at or above');
    expect(reasons[roleUngrantable]).toContain('ManageGuild');
  });

  it('plans nothing without Manage Roles', () => {
    const plan = planRestore(snapshot, current, {
      highestPosition: 10,
      permissions: P.KickMembers,
    });
    expect(plan.changes).toHaveLength(0);
  });

  it('lets an administrator bot grant permissions it would otherwise lack', () => {
    const plan = planRestore(snapshot, current, {
      highestPosition: 10,
      permissions: P.Administrator,
    });
    expect(plan.changes.map((change) => change.roleId)).toContain(roleUngrantable);
  });
});

describe('restoreRolePermissions', () => {
  let directory = '';
  afterEach(async () => {
    if (directory !== '') await rm(directory, { recursive: true, force: true });
    directory = '';
  });

  function makeGuild(failRole?: string) {
    const setters = new Map<string, ReturnType<typeof vi.fn>>();
    const roles = new Map(
      current.roles.map((role) => {
        const setPermissions = vi.fn(() =>
          role.id === failRole
            ? Promise.reject(Object.assign(new Error('secret token details'), { code: 50013 }))
            : Promise.resolve(undefined),
        );
        setters.set(role.id, setPermissions);
        return [
          role.id,
          {
            id: role.id,
            name: role.name,
            position: role.position,
            managed: role.managed,
            permissions: { bitfield: BigInt(role.permissions) },
            setPermissions,
          },
        ];
      }),
    );
    const guild = {
      id: guildId,
      roles: { cache: roles },
      channels: { cache: new Map() },
      members: {
        me: {
          roles: { highest: { position: 10 } },
          permissions: { bitfield: P.ManageRoles | P.KickMembers | P.BanMembers },
        },
      },
    } as unknown as Guild;
    return { guild, setters };
  }

  it('dry run changes nothing and takes no snapshot', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-restore-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'rt.json'));
    const { guild, setters } = makeGuild();
    const saveSnapshot = vi.fn();
    const text = await restoreRolePermissions(
      guild,
      store,
      { saveSnapshot } as unknown as SecurityService,
      actorId,
      snapshot,
      false,
    );
    expect(text).toContain('DRY RUN');
    expect([...setters.values()].every((setter) => setter.mock.calls.length === 0)).toBe(true);
    expect(saveSnapshot).not.toHaveBeenCalled();
    expect((await store.getGuild(guildId)).security.incidents).toHaveLength(0);
  });

  it('confirmed restore calls setPermissions only for eligible roles and records an incident', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-restore-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'rt.json'));
    const { guild, setters } = makeGuild();
    const saveSnapshot = vi.fn(() => Promise.resolve(snapshot));
    await restoreRolePermissions(
      guild,
      store,
      { saveSnapshot } as unknown as SecurityService,
      actorId,
      snapshot,
      true,
    );
    expect(saveSnapshot).toHaveBeenCalledOnce();
    const called = [...setters.entries()]
      .filter(([, setter]) => setter.mock.calls.length > 0)
      .map(([id]) => id);
    expect(called).toEqual([roleA]);
    expect(setters.get(roleA)).toHaveBeenCalledWith(P.KickMembers, expect.any(String));
    const incidents = (await store.getGuild(guildId)).security.incidents;
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      source: 'SecuritySnapshotService',
      automatic: false,
      actorId,
    });
  });

  it('reports a failing setPermissions without throwing or leaking error text', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-restore-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'rt.json'));
    const { guild } = makeGuild(roleA);
    const text = await restoreRolePermissions(
      guild,
      store,
      { saveSnapshot: vi.fn(() => Promise.resolve(snapshot)) } as unknown as SecurityService,
      actorId,
      snapshot,
      true,
    );
    expect(text).toContain('FAILED');
    expect(text).toContain('50013');
    expect(text).not.toContain('secret token details');
    expect(text).toContain('Restored 0/1');
  });

  it('aborts without changes when the pre-restore snapshot fails', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-restore-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'rt.json'));
    const { guild, setters } = makeGuild();
    const text = await restoreRolePermissions(
      guild,
      store,
      {
        saveSnapshot: vi.fn(() => Promise.reject(new Error('disk'))),
      } as unknown as SecurityService,
      actorId,
      snapshot,
      true,
    );
    expect(text).toContain('Aborted');
    expect(setters.get(roleA)).not.toHaveBeenCalled();
  });
});
