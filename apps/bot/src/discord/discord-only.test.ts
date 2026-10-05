import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROVISION_PHRASE } from '@xenon/discord/provisioning/pure';
import { FakeGuild } from '@xenon/discord/testing';

const holder = vi.hoisted((): { adapter: unknown } => ({ adapter: null }));

vi.mock('../runtime', () => ({
  botEnv: {},
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('./provisioning/guild-adapter', () => ({ discordGuildAdapter: () => holder.adapter }));
vi.mock('@xenon/discord/assets', () => ({
  assetsRoot: () => 'assets',
  readManifest: () => Promise.resolve({}),
  desiredAssets: () => [],
  readAssetData: vi.fn(),
}));

import { handleCommand } from './discord-only';
import { JsonDiscordRuntimeStore } from './runtime-store';

function interaction(
  fake: FakeGuild,
  commandName: string,
  options: { group?: string; subcommand?: string; strings?: Record<string, string> } = {},
  channelsFetch = vi.fn(),
) {
  return {
    commandName,
    guild: { id: fake.id, ownerId: fake.ownerId, channels: { fetch: channelsFetch } },
    user: { id: fake.ownerId },
    memberPermissions: null,
    options: {
      getSubcommandGroup: vi.fn(() => options.group),
      getSubcommand: vi.fn(() => options.subcommand),
      getString: vi.fn((name: string) => options.strings?.[name] ?? null),
    },
    reply: vi.fn(() => Promise.resolve()),
  };
}

function adopt(fake: FakeGuild, store: JsonDiscordRuntimeStore) {
  const view = interaction(fake, 'xenon', { group: 'setup', subcommand: 'adopt' });
  return handleCommand(view as never, {} as never, store).then(() => view);
}

describe('discord-only /xenon setup adopt', () => {
  let directory = '';
  let store: JsonDiscordRuntimeStore;
  let fake: FakeGuild;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-adopt-'));
    store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    fake = new FakeGuild();
    holder.adapter = fake;
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('adopts exact channels and roles into the JSON registry without the provisioning phrase', async () => {
    const announcements = fake.addChannel({ name: 'announcements', kind: 'text', parentId: null, topic: null });
    const moderator = fake.addRole('Moderator');

    const view = await adopt(fake, store);

    const entries = (await store.getGuild(fake.id)).entries;
    expect(entries).toContainEqual({
      logicalKey: 'channel.announcements',
      resourceType: 'CHANNEL',
      discordId: announcements,
      channelId: null,
      managed: true,
      contentHash: null,
      configurationHash: null,
      createdByRunId: null,
      metadata: { adopted: true, adoptedFrom: 'announcements', source: 'setup-adopt' },
    });
    expect(entries).toContainEqual(
      expect.objectContaining({ logicalKey: 'role.staff.moderator', resourceType: 'ROLE', discordId: moderator }),
    );
    expect(view.options.getString).not.toHaveBeenCalled();
    const content = (view.reply.mock.calls[0] as unknown as [{ content: string }])[0].content;
    expect(content).not.toContain(PROVISION_PHRASE);
    expect(content).toContain('Announcements → #announcements');
    expect(content).toContain('/announce is ready.');
  });

  it('skips ambiguous names and incompatible resource types', async () => {
    fake.addChannel({ name: 'welcome', kind: 'text', parentId: null, topic: null });
    fake.addChannel({ name: 'WELCOME', kind: 'text', parentId: null, topic: null });
    fake.addChannel({ name: 'rules', kind: 'voice', parentId: null, topic: null });

    await adopt(fake, store);

    const keys = (await store.getGuild(fake.id)).entries.map((entry) => entry.logicalKey);
    expect(keys).not.toContain('channel.welcome');
    expect(keys).not.toContain('channel.rules');
  });

  it('never calls Discord create, edit, delete, reorder, message or AutoMod APIs', async () => {
    fake.addChannel({ name: 'announcements', kind: 'text', parentId: null, topic: null });
    fake.addRole('Moderator');
    const mutations = [
      'createRole', 'editRole', 'orderRoles', 'deleteRole', 'createChannel', 'editChannel',
      'deleteChannel', 'createEmoji', 'createSticker', 'deleteEmoji', 'sendMessage', 'editMessage',
      'createAutoModRule', 'editAutoModRule', 'setAutoModEnabled',
    ] as const;
    const spies = mutations.map((name) => vi.spyOn(fake, name));

    await adopt(fake, store);

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
  });

  it('lets /announce post to the adopted announcements channel', async () => {
    const announcements = fake.addChannel({ name: 'announcements', kind: 'text', parentId: null, topic: null });
    await adopt(fake, store);
    const send = vi.fn(() => Promise.resolve());
    const channelsFetch = vi.fn(() => Promise.resolve({ isTextBased: () => true, send }));
    const view = interaction(
      fake,
      'announce',
      { strings: { title: 'Server update', message: 'Patch is live.' } },
      channelsFetch,
    );

    await handleCommand(view as never, {} as never, store);

    expect(channelsFetch).toHaveBeenCalledWith(announcements);
    expect(send).toHaveBeenCalledOnce();
    expect(view.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'Announcement posted.' }));
  });
});
