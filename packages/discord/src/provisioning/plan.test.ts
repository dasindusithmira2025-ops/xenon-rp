import { PermissionFlagsBits as P } from 'discord.js';
import { describe, expect, it } from 'vitest';

import { buildDesiredState } from './blueprint';
import { planSignature, unapprovedChanges } from './plan';
import { memoryRegistry } from './ports';
import { blueprintContext, FakeGuild, planOnce } from './testing';

import type { DesiredAsset, RegistryEntry } from './types';

const state = buildDesiredState(blueprintContext());

function entry(
  key: string,
  resourceType: RegistryEntry['resourceType'],
  discordId: string | null,
  extra: Partial<RegistryEntry> = {},
): RegistryEntry {
  return {
    logicalKey: key,
    resourceType,
    discordId,
    channelId: null,
    managed: true,
    contentHash: null,
    configurationHash: null,
    createdByRunId: null,
    metadata: {},
    ...extra,
  };
}

describe('planning an empty server', () => {
  it('creates everything, detects no conflicts and mutates nothing', async () => {
    const guild = new FakeGuild();
    const plan = await planOnce(guild, memoryRegistry(), state);

    expect(plan.profile).toBe('EMPTY');
    expect(plan.counts.conflict).toBe(0);
    expect(plan.counts.create).toBe(
      state.roles.length + state.channels.length + state.panels.length,
    );
    expect(plan.items.find((item) => item.key === 'hierarchy.roles')?.kind).toBe('MOVE');
    expect(guild.calls).toEqual([]);
  });
});

describe('conflicts', () => {
  it('reports an unmanaged #rules instead of creating #rules-2', async () => {
    const guild = new FakeGuild();
    guild.addChannel({ name: 'rules', kind: 'text', parentId: null, topic: null });
    const plan = await planOnce(guild, memoryRegistry(), state);
    const rules = plan.items.find((item) => item.key === 'channel.rules');
    expect(rules?.kind).toBe('CONFLICT');
    expect(rules?.summary).toContain('#rules already exists but is unmanaged');
  });

  it('matches category names regardless of emoji and case, and holds its children', async () => {
    const guild = new FakeGuild();
    guild.addChannel({ name: 'STAFF HQ', kind: 'category', parentId: null, topic: null });
    const plan = await planOnce(guild, memoryRegistry(), state);
    expect(plan.items.find((item) => item.key === 'category.staff')?.kind).toBe('CONFLICT');
    const child = plan.items.find((item) => item.key === 'channel.whitelist-review');
    expect(child?.kind).toBe('MANUAL_REVIEW');
    expect(child?.blockedBy).toBe('category.staff');
  });

  it('adopts an existing resource once the operator says so', async () => {
    const guild = new FakeGuild();
    const id = guild.addChannel({ name: 'rules', kind: 'text', parentId: null, topic: 'old' });
    const plan = await planOnce(
      guild,
      memoryRegistry([entry('channel.rules', 'CHANNEL', id)]),
      state,
    );
    const rules = plan.items.find((item) => item.key === 'channel.rules');
    expect(rules?.kind).toBe('UPDATE');
    expect(rules?.discordId).toBe(id);
  });

  it('leaves a resource alone when the operator keeps it unmanaged', async () => {
    const guild = new FakeGuild();
    const id = guild.addChannel({ name: 'rules', kind: 'text', parentId: null, topic: null });
    const plan = await planOnce(
      guild,
      memoryRegistry([entry('channel.rules', 'CHANNEL', id, { managed: false })]),
      state,
    );
    expect(plan.items.find((item) => item.key === 'channel.rules')?.kind).toBe('UNCHANGED');
  });

  it('creates an alternative name when asked', async () => {
    const guild = new FakeGuild();
    guild.addChannel({ name: 'rules', kind: 'text', parentId: null, topic: null });
    const plan = await planOnce(
      guild,
      memoryRegistry([
        entry('channel.rules', 'CHANNEL', null, { metadata: { alternativeName: 'rules-xenon' } }),
      ]),
      state,
    );
    expect(plan.items.find((item) => item.key === 'channel.rules')?.kind).toBe('CREATE');
  });

  it('marks a server with real structure as established', async () => {
    const guild = new FakeGuild();
    for (let index = 0; index < 12; index += 1)
      guild.addChannel({
        name: `chat-${String(index)}`,
        kind: 'text',
        parentId: null,
        topic: null,
      });
    for (let index = 0; index < 5; index += 1) guild.addRole(`Role ${String(index)}`);
    expect((await planOnce(guild, memoryRegistry(), state)).profile).toBe('ESTABLISHED');
  });
});

describe('hierarchy and permissions diagnostics', () => {
  it('refuses to touch a managed role that sits above the bot', async () => {
    const guild = new FakeGuild();
    const id = guild.addRole('Moderator', 150);
    const plan = await planOnce(
      guild,
      memoryRegistry([entry('role.staff.moderator', 'ROLE', id)]),
      state,
    );
    const moderator = plan.items.find((item) => item.key === 'role.staff.moderator');
    expect(moderator?.kind).toBe('MANUAL_REVIEW');
    expect(moderator?.blockedBy).toBe('BOT_ROLE_TOO_LOW');
    expect(plan.diagnostics.map((d) => d.code)).toContain('ROLE_ABOVE_BOT');
  });

  it('names the bootstrap permissions it is missing', async () => {
    const guild = new FakeGuild();
    guild.botPermissions = P.ViewChannel | P.SendMessages;
    const plan = await planOnce(guild, memoryRegistry(), state);
    const missing = plan.diagnostics.find((d) => d.code === 'MISSING_BOOTSTRAP_PERMISSION');
    expect(missing?.message).toContain('ManageChannels');
    expect(plan.diagnostics.map((d) => d.code)).toContain('MISSING_MANAGE_ROLES');
  });

  it('flags duplicate unmanaged roles', async () => {
    const guild = new FakeGuild();
    guild.addRole('Moderator');
    guild.addRole('Moderator');
    const plan = await planOnce(guild, memoryRegistry(), state);
    expect(plan.diagnostics.map((d) => d.code)).toContain('DUPLICATE_ROLE');
  });
});

describe('assets and capacity', () => {
  const asset = (name: string, priority: number, required = false): DesiredAsset => ({
    key: `emoji.${name}`,
    type: 'EMOJI',
    name,
    file: `generated/emoji/${name}.png`,
    hash: name,
    animated: false,
    priority,
    required,
  });

  it('uploads required and higher-priority assets first and blocks the rest', async () => {
    const guild = new FakeGuild();
    for (let index = 0; index < 49; index += 1)
      guild.emojis.set(`e${String(index)}`, {
        id: `e${String(index)}`,
        name: `old_${String(index)}`,
        animated: false,
      });
    const withAssets = {
      ...state,
      assets: [asset('optional', 1), asset('xenon_online', 50, true), asset('extra', 2)],
    };
    const plan = await planOnce(guild, memoryRegistry(), withAssets);
    const byKey = Object.fromEntries(
      plan.items.filter((i) => i.phase === 'ASSETS').map((i) => [i.key, i.kind]),
    );
    expect(byKey).toEqual({
      'emoji.xenon_online': 'CREATE',
      'emoji.optional': 'CAPACITY_BLOCKED',
      'emoji.extra': 'CAPACITY_BLOCKED',
    });
    expect(plan.diagnostics.map((d) => d.code)).toContain('CAPACITY_BLOCKED');
  });

  it('does not re-upload an unchanged asset and never touches a same-named emoji it does not own', async () => {
    const guild = new FakeGuild();
    guild.emojis.set('mine', { id: 'mine', name: 'xenon_online', animated: false });
    guild.emojis.set('theirs', { id: 'theirs', name: 'extra', animated: false });
    const plan = await planOnce(
      guild,
      memoryRegistry([
        entry('emoji.xenon_online', 'EMOJI', 'mine', { contentHash: 'xenon_online' }),
      ]),
      { ...state, assets: [asset('xenon_online', 1, true), asset('extra', 2)] },
    );
    const byKey = Object.fromEntries(
      plan.items.filter((i) => i.phase === 'ASSETS').map((i) => [i.key, i.kind]),
    );
    expect(byKey).toEqual({ 'emoji.xenon_online': 'UNCHANGED', 'emoji.extra': 'CONFLICT' });
  });

  it('detects a managed emoji replaced by a different one under the same name', async () => {
    const guild = new FakeGuild();
    guild.emojis.set('replacement', { id: 'replacement', name: 'xenon_online', animated: false });
    const plan = await planOnce(
      guild,
      memoryRegistry([
        entry('emoji.xenon_online', 'EMOJI', 'original', { contentHash: 'xenon_online' }),
      ]),
      { ...state, assets: [asset('xenon_online', 1, true)] },
    );
    expect(plan.items.find((i) => i.key === 'emoji.xenon_online')?.kind).toBe('MANUAL_REVIEW');
  });
});

describe('approval', () => {
  it('accepts a fresh plan that is a subset of the approved one', () => {
    expect(unapprovedChanges(['a:CREATE'], ['a:CREATE', 'b:UPDATE'])).toEqual([]);
  });

  it('rejects anything the operator never saw', () => {
    expect(unapprovedChanges(['a:CREATE', 'c:PERMISSION_CHANGE'], ['a:CREATE'])).toEqual([
      'c:PERMISSION_CHANGE',
    ]);
  });

  it('signs only mutating and drift items', async () => {
    const plan = await planOnce(new FakeGuild(), memoryRegistry(), state);
    expect(planSignature(plan.items).every((line) => !line.endsWith(':UNCHANGED'))).toBe(true);
  });
});
