import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChannelType } from 'discord.js';
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
  options: {
    group?: string;
    subcommand?: string;
    strings?: Record<string, string>;
    channels?: Record<string, { id: string }>;
  } = {},
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
      getChannel: vi.fn((name: string) => options.channels?.[name] ?? null),
    },
    reply: vi.fn(() => Promise.resolve()),
  };
}

function adopt(
  fake: FakeGuild,
  store: JsonDiscordRuntimeStore,
  channels: Record<string, { id: string }> = {},
  channelsFetch = vi.fn(),
) {
  const view = interaction(fake, 'xenon', { group: 'setup', subcommand: 'adopt', channels }, channelsFetch);
  return handleCommand(view as never, {} as never, store).then(() => view);
}

/** A discord.js-shaped channel whose every mutation method is a spy. */
function liveChannel(id: string, name: string, type: ChannelType, guildId: string) {
  return {
    id,
    name,
    type,
    guildId,
    isTextBased: () => type === ChannelType.GuildText || type === ChannelType.GuildAnnouncement,
    send: vi.fn(() => Promise.resolve()),
    edit: vi.fn(),
    delete: vi.fn(),
    setName: vi.fn(),
    setParent: vi.fn(),
    setPosition: vi.fn(),
    permissionOverwrites: { edit: vi.fn(), set: vi.fn(), create: vi.fn(), delete: vi.fn() },
  };
}

function fetchFrom<Channel extends { readonly id: string }>(channels: readonly Channel[]) {
  return vi.fn((id: string) => Promise.resolve(channels.find((channel) => channel.id === id) ?? null));
}

function replyText(view: { reply: { mock: { calls: unknown[][] } } }): string {
  return (view.reply.mock.calls[0] as [{ content: string }])[0].content;
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
    const content = replyText(view);
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

  it('binds explicitly selected decorated channels, then auto-adopts exact matches', async () => {
    const newsId = fake.addChannel({ name: '📢┃announcements', kind: 'announcement', parentId: null, topic: null });
    const logId = fake.addChannel({ name: '🛡┃mod-log', kind: 'text', parentId: null, topic: null });
    const welcomeId = fake.addChannel({ name: 'welcome', kind: 'text', parentId: null, topic: null });
    const news = liveChannel(newsId, '📢┃announcements', ChannelType.GuildAnnouncement, fake.id);
    const log = liveChannel(logId, '🛡┃mod-log', ChannelType.GuildText, fake.id);

    const view = await adopt(fake, store, { announcements: news, logs: log }, fetchFrom([news, log]));

    const entries = (await store.getGuild(fake.id)).entries;
    expect(entries).toContainEqual({
      logicalKey: 'channel.announcements',
      resourceType: 'CHANNEL',
      discordId: newsId,
      channelId: null,
      managed: true,
      contentHash: null,
      configurationHash: null,
      createdByRunId: null,
      metadata: { adopted: true, adoptedFrom: '📢┃announcements', source: 'setup-adopt-explicit' },
    });
    expect(entries).toContainEqual(
      expect.objectContaining({
        logicalKey: 'channel.bot-ops',
        discordId: logId,
        metadata: { adopted: true, adoptedFrom: '🛡┃mod-log', source: 'setup-adopt-explicit' },
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        logicalKey: 'channel.welcome',
        discordId: welcomeId,
        metadata: { adopted: true, adoptedFrom: 'welcome', source: 'setup-adopt' },
      }),
    );
    const content = replyText(view);
    expect(content).toContain('Explicitly mapped:\nAnnouncements → #📢┃announcements\nLogs → #🛡┃mod-log');
    expect(content).toContain('Auto adopted: 1\nAlready mapped: 0');
    expect(content).toContain('/announce is ready.');
  });

  it('lets an explicit selection override an exact-name automatic match', async () => {
    const exactId = fake.addChannel({ name: 'announcements', kind: 'text', parentId: null, topic: null });
    const chosenId = fake.addChannel({ name: '📢┃news', kind: 'announcement', parentId: null, topic: null });
    const chosen = liveChannel(chosenId, '📢┃news', ChannelType.GuildAnnouncement, fake.id);

    await adopt(fake, store, { announcements: chosen }, fetchFrom([chosen]));

    const entries = (await store.getGuild(fake.id)).entries;
    expect(entries.find((entry) => entry.logicalKey === 'channel.announcements')?.discordId).toBe(chosenId);
    expect(entries.some((entry) => entry.discordId === exactId)).toBe(false);
  });

  it.each([
    ['a channel from another guild', ChannelType.GuildText, '999999999999999999'],
    ['a voice channel', ChannelType.GuildVoice, null],
    ['a forum channel', ChannelType.GuildForum, null],
  ])('rejects %s and saves nothing', async (_label, type, otherGuild) => {
    const id = fake.addChannel({ name: 'logs', kind: 'text', parentId: null, topic: null });
    fake.addChannel({ name: 'welcome', kind: 'text', parentId: null, topic: null });
    const selected = liveChannel(id, 'logs', type, otherGuild ?? fake.id);

    const view = await adopt(fake, store, { logs: selected }, fetchFrom([selected]));

    expect((await store.getGuild(fake.id)).entries).toEqual([]);
    expect(replyText(view)).toContain('Nothing was saved.');
  });

  it('rejects one channel selected for two roles and saves nothing', async () => {
    const id = fake.addChannel({ name: 'staff', kind: 'text', parentId: null, topic: null });
    const selected = liveChannel(id, 'staff', ChannelType.GuildText, fake.id);

    await adopt(fake, store, { logs: selected, review: selected }, fetchFrom([selected]));

    expect((await store.getGuild(fake.id)).entries).toEqual([]);
  });

  it('never calls Discord mutation or AutoMod APIs during explicit binding', async () => {
    const newsId = fake.addChannel({ name: '📢┃news', kind: 'announcement', parentId: null, topic: null });
    const rulesId = fake.addChannel({ name: '📜┃rules', kind: 'text', parentId: null, topic: null });
    const news = liveChannel(newsId, '📢┃news', ChannelType.GuildAnnouncement, fake.id);
    const rules = liveChannel(rulesId, '📜┃rules', ChannelType.GuildText, fake.id);
    const adapterSpies = [
      'createRole', 'editRole', 'orderRoles', 'deleteRole', 'createChannel', 'editChannel',
      'deleteChannel', 'createEmoji', 'createSticker', 'deleteEmoji', 'sendMessage', 'editMessage',
      'createAutoModRule', 'editAutoModRule', 'setAutoModEnabled',
    ].map((name) => vi.spyOn(fake, name as 'createRole'));

    await adopt(fake, store, { announcements: news, rules }, fetchFrom([news, rules]));

    for (const spy of adapterSpies) expect(spy).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
    for (const channel of [news, rules]) {
      for (const method of [channel.send, channel.edit, channel.delete, channel.setName, channel.setParent, channel.setPosition])
        expect(method).not.toHaveBeenCalled();
      for (const method of Object.values(channel.permissionOverwrites)) expect(method).not.toHaveBeenCalled();
    }
    expect((await store.getGuild(fake.id)).entries.map((entry) => entry.logicalKey)).toEqual(
      expect.arrayContaining(['channel.announcements', 'channel.rules']),
    );
  });

  it('lets /announce post to an explicitly bound announcements channel', async () => {
    const newsId = fake.addChannel({ name: '📢┃news', kind: 'announcement', parentId: null, topic: null });
    const news = liveChannel(newsId, '📢┃news', ChannelType.GuildAnnouncement, fake.id);
    await adopt(fake, store, { announcements: news }, fetchFrom([news]));
    const channelsFetch = fetchFrom([news]);
    const view = interaction(
      fake,
      'announce',
      { strings: { title: 'Server update', message: 'Patch is live.' } },
      channelsFetch,
    );

    await handleCommand(view as never, {} as never, store);

    expect(channelsFetch).toHaveBeenCalledWith(newsId);
    expect(news.send).toHaveBeenCalledOnce();
  });
});
