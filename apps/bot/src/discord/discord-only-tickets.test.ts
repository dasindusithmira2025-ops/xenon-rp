import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChannelType, Collection, OverwriteType, PermissionFlagsBits as P } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const flags = vi.hoisted(() => ({ databaseLoaded: false }));
const adapter = vi.hoisted(() => ({
  discordGuildAdapter: vi.fn(() => {
    throw new Error('Provisioning adapter must not be used by tickets');
  }),
}));

vi.mock('@xenon/database', () => {
  flags.databaseLoaded = true;
  return {};
});
vi.mock('../runtime', () => ({
  botEnv: {},
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('./provisioning/guild-adapter', () => adapter);
vi.mock('@xenon/discord/assets', () => ({
  assetsRoot: () => 'assets',
  readManifest: () => Promise.resolve({}),
  desiredAssets: () => [],
  readAssetData: vi.fn(),
}));

import { handleButton, handleCommand, handleSelect } from './discord-only';
import { DISCORD_ONLY_COMMANDS } from './discord-only-commands';
import {
  ALREADY_CLOSING,
  formatDuration,
  resetTicketCooldowns,
  setTicketDeleteDelay,
  ticketCenterPanel,
  ticketChannelName,
} from './discord-only-tickets';
import { JsonDiscordRuntimeStore, type TicketRecord } from './runtime-store';

const GUILD = '100000000000000001';
const GUILD_OWNER = '100000000000000009';
const BOT = '300000000000000001';
const OWNER = '400000000000000001';
const OTHER = '400000000000000002';
const STAFF = '400000000000000003';
const MANAGER = '400000000000000004';
const PANEL = '500000000000000001';
const CATEGORY = '500000000000000002';
const LOG = '500000000000000003';
const OTHER_PANEL = '500000000000000004';
const STAFF_ROLE = '600000000000000001';
const NEW_STAFF_ROLE = '600000000000000002';

const TYPES = [
  ['GENERAL', '💬', 'General Support'],
  ['TECHNICAL', '🛠️', 'Technical Support'],
  ['CHARACTER', '🎭', 'Character Issue'],
  ['WHITELIST', '📜', 'Whitelist Support'],
  ['PLAYER_REPORT', '🚩', 'Player Report'],
  ['BUSINESS', '💼', 'Business / Organization'],
] as const;

let sequence = 900000000000000000n;
let clock = Date.parse('2026-10-06T10:00:00.000Z');
const nextId = () => String((sequence += 1n));

interface FakeMessage {
  id: string;
  channelId: string;
  createdTimestamp: number;
  content: string;
  author: { id: string; username: string };
  embeds: { title: string | null }[];
  attachments: Collection<string, { url: string }>;
  payload: unknown;
  edit: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

interface Payload {
  content?: string;
  embeds?: { title?: string }[];
}

/** Shared event log so tests can assert the order of close steps. */
let events: string[] = [];

function fakeChannel(id: string, name: string, type: ChannelType) {
  const messages = new Map<string, FakeMessage>();
  const record = (author: { id: string; username: string }, payload: Payload, attachmentUrls: string[] = []) => {
    clock += 1_000;
    const message: FakeMessage = {
      id: nextId(),
      channelId: id,
      createdTimestamp: clock,
      content: payload.content ?? '',
      author,
      embeds: (payload.embeds ?? []).map((embed) => ({ title: embed.title ?? null })),
      attachments: new Collection(attachmentUrls.map((url, index) => [String(index), { url }])),
      payload,
      edit: vi.fn((next: unknown) => {
        message.payload = next;
        return Promise.resolve(message);
      }),
      delete: vi.fn(() => Promise.resolve()),
    };
    messages.set(message.id, message);
    return message;
  };
  const channel = {
    id,
    name,
    type,
    guildId: GUILD,
    createOptions: undefined as unknown,
    messages: {
      store: messages,
      fetch: vi.fn((query: string | { limit: number; before?: string }) => {
        if (typeof query === 'string') {
          const message = messages.get(query);
          return message === undefined
            ? Promise.reject(Object.assign(new Error('Unknown Message'), { code: 10008 }))
            : Promise.resolve(message);
        }
        const newestFirst = [...messages.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
        const start = query.before === undefined ? 0 : newestFirst.findIndex((message) => message.id === query.before) + 1;
        const page = newestFirst.slice(start, start + query.limit);
        return Promise.resolve(new Collection(page.map((message) => [message.id, message])));
      }),
    },
    /** A member message, as if typed into the channel. */
    post: (userId: string, username: string, content: string, attachmentUrls: string[] = []) =>
      record({ id: userId, username }, { content }, attachmentUrls),
    permissionsFor: vi.fn(() => ({ missing: vi.fn(() => []) })),
    send: vi.fn((payload: Payload & { files?: unknown[] }) => {
      events.push(`send:${name}`);
      return Promise.resolve(record({ id: BOT, username: 'Xenon' }, payload));
    }),
    permissionOverwrites: {
      cache: new Map<string, unknown>(),
      edit: vi.fn(() => Promise.resolve()),
      delete: vi.fn(() => Promise.resolve()),
    },
    setName: vi.fn(),
    edit: vi.fn(),
    setParent: vi.fn(),
    setPosition: vi.fn(),
    delete: vi.fn(() => {
      events.push(`delete:${name}`);
      return Promise.resolve();
    }),
  };
  return channel;
}
type FakeChannel = ReturnType<typeof fakeChannel>;

function fakeGuild() {
  const channels = new Map<string, FakeChannel>([
    [PANEL, fakeChannel(PANEL, 'support-ticket', ChannelType.GuildText)],
    [OTHER_PANEL, fakeChannel(OTHER_PANEL, 'help-desk', ChannelType.GuildText)],
    [CATEGORY, fakeChannel(CATEGORY, 'Xenon Support', ChannelType.GuildCategory)],
    [LOG, fakeChannel(LOG, 'ticket-log', ChannelType.GuildText)],
  ]);
  const memberRoles = new Map([[STAFF, [STAFF_ROLE]]]);
  const guild = {
    id: GUILD,
    ownerId: GUILD_OWNER,
    iconURL: () => 'https://cdn.discordapp.com/icons/xenon.png',
    channels: {
      cache: channels,
      fetch: vi.fn((id: string) => {
        const channel = channels.get(id);
        return channel === undefined
          ? Promise.reject(Object.assign(new Error('Unknown Channel'), { code: 10003 }))
          : Promise.resolve(channel);
      }),
      create: vi.fn((options: { name: string; type: ChannelType; permissionOverwrites: { id: string }[] }) => {
        const channel = fakeChannel(nextId(), options.name, options.type);
        channel.createOptions = options;
        for (const overwrite of options.permissionOverwrites) channel.permissionOverwrites.cache.set(overwrite.id, overwrite);
        channels.set(channel.id, channel);
        return Promise.resolve(channel);
      }),
    },
    roles: {
      fetch: vi.fn((id: string) =>
        Promise.resolve(id === STAFF_ROLE || id === NEW_STAFF_ROLE ? { id, guild: { id: GUILD } } : null),
      ),
      create: vi.fn(),
    },
    members: {
      fetchMe: vi.fn(() => Promise.resolve({ id: BOT, permissions: { missing: vi.fn(() => []) } })),
      fetch: vi.fn((id: string) => Promise.resolve({ id, roles: { cache: new Set(memberRoles.get(id) ?? []) } })),
    },
    autoModerationRules: { fetch: vi.fn(), create: vi.fn(), edit: vi.fn() },
  };
  return { guild, channels };
}
type Fake = ReturnType<typeof fakeGuild>;

/** Whether the fake application has the Message Content Intent enabled. */
let messageContent = true;
const client = { application: { flags: { any: () => messageContent } } };

function slash(fake: Fake, subcommand: string, picks: Partial<Record<string, string>> = {}) {
  const ids: Record<string, string> = { panel_channel: PANEL, log_channel: LOG, staff_role: STAFF_ROLE, ...picks };
  return {
    commandName: 'xenon',
    guild: fake.guild,
    user: { id: MANAGER },
    memberPermissions: { has: (bit: bigint) => bit === P.ManageGuild },
    client,
    options: {
      getSubcommandGroup: () => 'tickets',
      getSubcommand: () => subcommand,
      getChannel: (name: string) => ({ id: ids[name] }),
      getRole: (name: string) => ({ id: ids[name] }),
    },
    deferReply: vi.fn(() => Promise.resolve()),
    editReply: vi.fn(() => Promise.resolve()),
    reply: vi.fn(() => Promise.resolve()),
  };
}

function select(fake: Fake, userId: string, messageId: string | null, value = 'GENERAL') {
  return {
    customId: 'xn:ticket:create',
    guild: fake.guild,
    channelId: PANEL,
    message: { id: messageId },
    user: { id: userId, username: 'Player.One!' },
    memberPermissions: { has: (bit: bigint) => userId === MANAGER && bit === P.ManageGuild },
    values: [value],
    deferReply: vi.fn(() => Promise.resolve()),
    editReply: vi.fn(() => Promise.resolve()),
    reply: vi.fn(() => Promise.resolve()),
  };
}

function button(fake: Fake, action: 'close' | 'claim', userId: string, ticket: TicketRecord, channelId = ticket.channelId) {
  return {
    customId: `xn:ticket:${action}:${ticket.ticketId}`,
    guild: fake.guild,
    channelId,
    user: { id: userId },
    memberPermissions: { has: (bit: bigint) => userId === MANAGER && bit === P.ManageGuild },
    client,
    reply: vi.fn(() => Promise.resolve()),
    update: vi.fn(() => Promise.resolve()),
    deferUpdate: vi.fn(() => Promise.resolve()),
    editReply: vi.fn(() => Promise.resolve()),
    followUp: vi.fn(() => Promise.resolve()),
  };
}

function lastText(mock: { mock: { calls: unknown[][] } }): string {
  const value = mock.mock.calls.at(-1)?.[0];
  return typeof value === 'string' ? value : ((value as { content?: string } | undefined)?.content ?? '');
}

interface CreateOptions {
  name: string;
  type: ChannelType;
  parent?: string;
  permissionOverwrites: { id: string; type: OverwriteType; allow?: bigint[]; deny?: bigint[] }[];
}

interface SelectJson {
  custom_id: string;
  placeholder: string;
  options: { value: string; label: string; emoji?: { name: string } }[];
}

describe('discord-only tickets', () => {
  let directory = '';
  let file = '';
  let store: JsonDiscordRuntimeStore;
  let fake: Fake;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-tickets-'));
    file = join(directory, 'discord-runtime.json');
    store = new JsonDiscordRuntimeStore(file);
    fake = fakeGuild();
    events = [];
    resetTicketCooldowns();
    setTicketDeleteDelay(0);
    messageContent = true;
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function publish(picks: Partial<Record<string, string>> = {}) {
    const view = slash(fake, 'publish', picks);
    await handleCommand(view as never, {} as never, store);
    return view;
  }

  async function panelMessageId(): Promise<string> {
    const id = (await store.getGuild(GUILD)).ticketConfig?.ticketPanelMessageId;
    if (id == null) throw new Error('panel not published');
    return id;
  }

  async function open(userId: string, type = 'GENERAL') {
    const view = select(fake, userId, await panelMessageId(), type);
    await handleSelect(view as never, store);
    return view;
  }

  async function onlyTicket(): Promise<TicketRecord> {
    const tickets = Object.values((await store.getGuild(GUILD)).tickets);
    expect(tickets).toHaveLength(1);
    const [ticket] = tickets;
    if (ticket === undefined) throw new Error('ticket missing');
    return ticket;
  }

  async function close(userId: string, ticket: TicketRecord) {
    const view = button(fake, 'close', userId, ticket);
    await handleButton(view as never, store);
    return view;
  }

  const created = (type: ChannelType) =>
    (fake.guild.channels.create.mock.calls as unknown as [CreateOptions][])
      .map(([options]) => options)
      .filter((options) => options.type === type);
  const ticketChannelsCreated = () => created(ChannelType.GuildText).length;
  const logSends = () => fake.channels.get(LOG)?.send.mock.calls.map(([payload]) => payload) ?? [];

  // ── Panel ────────────────────────────────────────────────────────────────

  it('registers ManageGuild /xenon tickets publish and status with required native options', () => {
    const xenon = DISCORD_ONLY_COMMANDS.find((command) => command.name === 'xenon');
    expect(xenon?.default_member_permissions).toBe(String(P.ManageGuild));
    const tickets = xenon?.options?.find((option) => option.name === 'tickets');
    const subcommands = tickets !== undefined && 'options' in tickets ? (tickets.options ?? []) : [];
    expect(subcommands.map((sub) => sub.name)).toEqual(['publish', 'status']);
    const publishOptions = subcommands[0] !== undefined && 'options' in subcommands[0] ? (subcommands[0].options ?? []) : [];
    expect(publishOptions.map((option) => [option.name, option.required])).toEqual([
      ['panel_channel', true],
      ['log_channel', true],
      ['staff_role', true],
    ]);
  });

  it('renders the premium panel with every category, emoji and the xn:ticket:create select', () => {
    const panel = ticketCenterPanel();
    const embed = panel.embeds[0];
    expect(embed?.title).toBe('🎫 XENON SUPPORT CENTER');
    expect(embed?.description).toContain('Welcome to the **Xenon Roleplay Support Center**.');
    expect(embed?.footer?.text).toBe('Xenon Support • Xenon Roleplay');
    expect(embed?.timestamp).toBeDefined();
    const field = embed?.fields?.find((entry) => entry.name === '📊 AVAILABLE CATEGORIES');
    for (const [, emoji, label] of TYPES) expect(field?.value).toContain(`${emoji} **${label}**`);

    const menu = panel.components[0]?.components[0] as unknown as SelectJson;
    expect(menu.custom_id).toBe('xn:ticket:create');
    expect(menu.placeholder).toBe('🎟️ Select a support category');
    expect(menu.options.map((option) => [option.value, option.emoji?.name, option.label])).toEqual(TYPES.map((type) => [...type]));
    expect(new Set(menu.options.map((option) => option.emoji?.name)).size).toBe(TYPES.length);
    expect(menu.options.map((option) => option.emoji?.name)).not.toContain('🎫');
    expect(JSON.stringify(panel)).not.toMatch(/Staff Report|Developer/);
  });

  it('adds the website button only for a public https site URL', () => {
    expect(ticketCenterPanel({ siteUrl: 'https://xenonrp.lk' }).components).toHaveLength(2);
    for (const siteUrl of ['http://localhost:3200', 'https://localhost', 'http://xenonrp.lk', 'https://example.com', 'not a url', null])
      expect(ticketCenterPanel({ siteUrl }).components, String(siteUrl)).toHaveLength(1);
  });

  it('publish creates one private category per type, stores ids and posts one panel', async () => {
    const view = await publish();

    const state = await store.getGuild(GUILD);
    const panel = fake.channels.get(PANEL);
    expect(panel?.send).toHaveBeenCalledOnce();
    expect(state.ticketConfig).toEqual({
      ticketPanelChannelId: PANEL,
      ticketLogChannelId: LOG,
      ticketStaffRoleId: STAFF_ROLE,
      ticketPanelMessageId: [...(panel?.messages.store.keys() ?? [])][0],
    });
    const categories = created(ChannelType.GuildCategory);
    expect(categories.map((options) => options.name)).toEqual(TYPES.map(([, , label]) => `${label} Tickets`));
    for (const options of categories) {
      expect(options.permissionOverwrites.find((entry) => entry.id === GUILD)).toMatchObject({ deny: [P.ViewChannel] });
      expect(options.permissionOverwrites.flatMap((entry) => entry.allow ?? [])).not.toContain(P.Administrator);
    }
    expect(Object.keys(state.ticketCategories)).toEqual(TYPES.map(([value]) => value));
    expect(lastText(view.editReply)).toContain(`✅ Xenon Support Center published in <#${PANEL}>`);
  });

  it('publish edits the existing panel and reuses categories instead of duplicating', async () => {
    await publish();
    const first = await panelMessageId();
    const categories = (await store.getGuild(GUILD)).ticketCategories;
    const view = await publish();

    const panel = fake.channels.get(PANEL);
    expect(panel?.send).toHaveBeenCalledOnce();
    expect(panel?.messages.store.get(first)?.edit).toHaveBeenCalledOnce();
    expect(await panelMessageId()).toBe(first);
    expect(created(ChannelType.GuildCategory)).toHaveLength(TYPES.length);
    expect((await store.getGuild(GUILD)).ticketCategories).toEqual(categories);
    expect(lastText(view.editReply)).toBe(`✅ Xenon Support Center published in <#${PANEL}>`);
  });

  it('moving the panel removes the old Xenon panel so only one stays live', async () => {
    await publish();
    const first = await panelMessageId();
    await publish({ panel_channel: OTHER_PANEL });

    expect(fake.channels.get(PANEL)?.messages.store.get(first)?.delete).toHaveBeenCalledOnce();
    expect(fake.channels.get(OTHER_PANEL)?.send).toHaveBeenCalledOnce();
  });

  it('publish rejects a category supplied as the log channel and saves nothing', async () => {
    const view = await publish({ log_channel: CATEGORY });

    expect((await store.getGuild(GUILD)).ticketConfig).toBeNull();
    expect(fake.guild.channels.create).not.toHaveBeenCalled();
    expect(lastText(view.editReply)).toContain('Nothing was saved.');
  });

  // ── Create ───────────────────────────────────────────────────────────────

  it('creates one private ticket channel with a readable name and the premium opening message', async () => {
    await publish();
    const view = await open(OWNER, 'TECHNICAL');

    expect(ticketChannelsCreated()).toBe(1);
    const ticket = await onlyTicket();
    const ticketChannel = fake.channels.get(ticket.channelId);
    const options = ticketChannel?.createOptions as CreateOptions;
    expect(options.name).toBe('ticket-player-one');
    expect(options.parent).toBe((await store.getGuild(GUILD)).ticketCategories.TECHNICAL);
    const overwrite = (id: string) => options.permissionOverwrites.find((entry) => entry.id === id);
    expect(overwrite(GUILD)).toMatchObject({ type: OverwriteType.Role, deny: [P.ViewChannel] });
    expect(overwrite(GUILD)?.allow).toBeUndefined();
    expect(overwrite(OWNER)?.allow).toEqual(expect.arrayContaining([P.ViewChannel, P.SendMessages]));
    expect(overwrite(STAFF_ROLE)?.allow).toEqual(expect.arrayContaining([P.ViewChannel, P.SendMessages]));
    expect(options.permissionOverwrites.map((entry) => entry.id).sort()).toEqual([BOT, GUILD, OWNER, STAFF_ROLE].sort());
    expect(options.permissionOverwrites.flatMap((entry) => entry.allow ?? [])).not.toContain(P.Administrator);

    const opening = JSON.stringify(ticketChannel?.send.mock.calls[0]);
    for (const expected of ['🎫 XENON SUPPORT · TICKET OPENED', ticket.ticketId, 'Technical Support', `<@${OWNER}>`, 'What happens next?', `Xenon Support • ${ticket.ticketId}`, 'CLOSE TICKET', 'CLAIM TICKET'])
      expect(opening).toContain(expected);
    expect(lastText(view.editReply)).toBe(`Ticket created: <#${ticket.channelId}>`);
  });

  it('keeps channel names readable, unique and within Discord limits', () => {
    expect(ticketChannelName('dazz.dev', new Set())).toBe('ticket-dazz-dev');
    expect(ticketChannelName('dazz.dev', new Set(['ticket-dazz-dev']))).toBe('ticket-dazz-dev-2');
    expect(ticketChannelName('dazz.dev', new Set(['ticket-dazz-dev', 'ticket-dazz-dev-2']))).toBe('ticket-dazz-dev-3');
    expect(ticketChannelName('✨✨', new Set())).toBe('ticket-member');
    expect(ticketChannelName('a'.repeat(300), new Set([`ticket-${'a'.repeat(80)}`])).length).toBeLessThanOrEqual(100);
  });

  it('keeps report tickets private to the owner, staff role and bot', async () => {
    await publish();
    await open(OWNER, 'PLAYER_REPORT');
    const ticket = await onlyTicket();
    const options = fake.channels.get(ticket.channelId)?.createOptions as CreateOptions;

    expect(options.parent).toBe((await store.getGuild(GUILD)).ticketCategories.PLAYER_REPORT);
    expect(options.permissionOverwrites.map((entry) => entry.id).sort()).toEqual([BOT, GUILD, OWNER, STAFF_ROLE].sort());
    expect(fake.channels.get(PANEL)?.send).toHaveBeenCalledOnce();
  });

  it('rejects the retired Staff Report and Developer ticket types', async () => {
    await publish();
    for (const retired of ['STAFF_REPORT', 'DEVELOPER']) {
      const view = await open(MANAGER, retired);
      expect(lastText(view.editReply)).toContain('listed ticket categories');
    }
    expect(ticketChannelsCreated()).toBe(0);
    expect(created(ChannelType.GuildCategory).map((options) => options.name)).not.toEqual(
      expect.arrayContaining(['Staff Report Tickets', 'Developer Task Tickets']),
    );
  });

  it('rejects unknown categories, stale panels, a second open ticket and rapid re-creation', async () => {
    await publish();
    const unknown = select(fake, OWNER, await panelMessageId(), 'OTHER');
    await handleSelect(unknown as never, store);
    expect(lastText(unknown.editReply)).toContain('listed ticket categories');

    const stale = select(fake, OWNER, '999999999999999999');
    await handleSelect(stale as never, store);
    expect(lastText(stale.editReply)).toContain('no longer active');

    await open(OWNER);
    const second = await open(OWNER);
    expect(lastText(second.editReply)).toContain('You already have an open ticket');

    await close(OWNER, await onlyTicket());
    const rapid = await open(OWNER);
    expect(lastText(rapid.editReply)).toContain('Please wait');
    expect(ticketChannelsCreated()).toBe(1);
  });

  it('refuses to create tickets when the configured log channel disappears', async () => {
    await publish();
    fake.channels.delete(LOG);
    const view = await open(OWNER);

    expect(ticketChannelsCreated()).toBe(0);
    expect(lastText(view.editReply)).toContain('/xenon tickets publish');
  });

  // ── Claim ────────────────────────────────────────────────────────────────

  it('lets only staff claim a ticket, once', async () => {
    await publish();
    await open(OWNER);
    const ticket = await onlyTicket();

    const member = button(fake, 'claim', OWNER, ticket);
    await handleButton(member as never, store);
    expect(lastText(member.reply)).toContain('Only the Xenon staff team');

    const staff = button(fake, 'claim', STAFF, ticket);
    await handleButton(staff as never, store);
    expect((await onlyTicket()).claimedBy).toBe(STAFF);
    expect(JSON.stringify(staff.update.mock.calls[0])).toContain('🙋 Claimed By');

    const again = button(fake, 'claim', MANAGER, ticket);
    await handleButton(again as never, store);
    expect(lastText(again.reply)).toContain('already been claimed');
    expect((await onlyTicket()).claimedBy).toBe(STAFF);
  });

  // ── Close ────────────────────────────────────────────────────────────────

  it('owner can close: CLOSED is persisted, the log and transcript are posted, then the channel is deleted', async () => {
    await publish();
    await open(OWNER, 'TECHNICAL');
    const ticket = await onlyTicket();
    const channel = fake.channels.get(ticket.channelId);
    if (channel === undefined) throw new Error('ticket channel missing');
    channel.post(OWNER, 'player.one', 'My launcher crashes', ['https://cdn.discordapp.com/attachments/1/2/crash.png']);
    channel.post(STAFF, 'staffer', 'Please send your logs');
    channel.delete.mockImplementation(async () => {
      events.push(`status-at-delete:${String((await store.getGuild(GUILD)).tickets[ticket.ticketId]?.status)}`);
      events.push(`delete:${channel.name}`);
    });
    events = [];

    const view = await close(OWNER, ticket);

    expect(events).toEqual([`send:${channel.name}`, 'send:ticket-log', 'status-at-delete:CLOSED', `delete:${channel.name}`]);
    expect(view.editReply).toHaveBeenCalledWith(expect.objectContaining({ components: [expect.anything()] }));
    expect(JSON.stringify(view.editReply.mock.calls[0])).toContain('"disabled":true');
    expect(JSON.stringify(channel.send.mock.calls.at(-1))).toContain('🔒 XENON SUPPORT · TICKET CLOSED');

    const [log] = logSends() as { embeds: { title: string; fields: { name: string; value: string }[] }[]; files: { name: string; attachment: Buffer }[] }[];
    expect(log?.embeds[0]?.title).toBe('📁 XENON TICKET CLOSED');
    const fields = Object.fromEntries((log?.embeds[0]?.fields ?? []).map((field) => [field.name, field.value]));
    expect(fields).toMatchObject({ Ticket: ticket.ticketId, Category: 'Technical Support', Status: 'CLOSED' });
    for (const name of ['Owner', 'Closed By']) expect(fields[name]).toContain(OWNER);
    for (const name of ['Opened', 'Closed', 'Duration']) expect(fields[name]).toBeDefined();
    expect(fields.Channel).toContain('ticket-player-one');
    expect(fields.Channel).toContain(ticket.channelId);

    expect(log?.files[0]?.name).toBe(`${ticket.ticketId}-transcript.txt`);
    const transcript = log?.files[0]?.attachment.toString('utf8') ?? '';
    expect(transcript).toContain(`player.one (${OWNER}): My launcher crashes`);
    expect(transcript).toContain('attachment: https://cdn.discordapp.com/attachments/1/2/crash.png');
    expect(transcript).toContain(`staffer (${STAFF}): Please send your logs`);
    expect(transcript.indexOf('My launcher crashes')).toBeLessThan(transcript.indexOf('Please send your logs'));

    const stored = (await store.getGuild(GUILD)).tickets[ticket.ticketId];
    expect(stored).toMatchObject({ status: 'CLOSED', closedBy: OWNER, channelId: ticket.channelId });
    expect(stored?.closedAt).not.toBeNull();
  });

  it('staff role members and ManageGuild users can close', async () => {
    await publish();
    await open(OWNER);
    await close(STAFF, await onlyTicket());
    expect(await onlyTicket()).toMatchObject({ status: 'CLOSED', closedBy: STAFF });

    resetTicketCooldowns();
    await open(OTHER);
    const second = Object.values((await store.getGuild(GUILD)).tickets).find((ticket) => ticket.ownerId === OTHER);
    if (second === undefined) throw new Error('second ticket missing');
    await close(MANAGER, second);
    expect((await store.getGuild(GUILD)).tickets[second.ticketId]).toMatchObject({ status: 'CLOSED', closedBy: MANAGER });
  });

  it('an unrelated user cannot close somebody else’s ticket', async () => {
    await publish();
    await open(OWNER);
    const ticket = await onlyTicket();
    const view = await close(OTHER, ticket);

    expect((await onlyTicket()).status).toBe('OPEN');
    expect(view.deferUpdate).not.toHaveBeenCalled();
    expect(fake.channels.get(ticket.channelId)?.delete).not.toHaveBeenCalled();
    expect(lastText(view.reply)).toContain('Only the ticket owner');
  });

  it('rejects a close button pressed outside the ticket channel', async () => {
    await publish();
    await open(OWNER);
    const ticket = await onlyTicket();
    await handleButton(button(fake, 'close', OWNER, ticket, PANEL) as never, store);

    expect((await onlyTicket()).status).toBe('OPEN');
  });

  it('a failed transcript does not prevent logging or deletion', async () => {
    await publish();
    await open(OWNER);
    const ticket = await onlyTicket();
    const channel = fake.channels.get(ticket.channelId);
    channel?.messages.fetch.mockRejectedValue(new Error('Missing Access'));

    await close(OWNER, ticket);

    const [log] = logSends() as { embeds: { description: string }[]; files: unknown[] }[];
    expect(log?.embeds[0]?.description).toBe('Transcript unavailable');
    expect(log?.files).toEqual([]);
    expect(channel?.delete).toHaveBeenCalledOnce();
  });

  it('a failed delete keeps the ticket CLOSED, warns #ticket-log once and does not retry', async () => {
    await publish();
    await open(OWNER);
    const ticket = await onlyTicket();
    const channel = fake.channels.get(ticket.channelId);
    channel?.delete.mockRejectedValue(Object.assign(new Error('Missing Permissions'), { code: 50013 }));

    await close(OWNER, ticket);

    expect(channel?.delete).toHaveBeenCalledOnce();
    expect((await onlyTicket()).status).toBe('CLOSED');
    const titles = JSON.stringify(logSends());
    expect(titles).toContain('📁 XENON TICKET CLOSED');
    expect(titles).toContain('⚠️ TICKET CHANNEL NOT DELETED');
    expect(titles).toContain('50013');
  });

  it('falls back to a metadata-only log when the transcript cannot be uploaded, then deletes', async () => {
    await publish();
    await open(OWNER);
    const ticket = await onlyTicket();
    const log = fake.channels.get(LOG);
    const realSend = log?.send.getMockImplementation();
    log?.send.mockImplementation((payload: Payload & { files?: unknown[] }) =>
      (payload.files?.length ?? 0) > 0
        ? Promise.reject(new Error('Missing Permissions'))
        : (realSend?.(payload) ?? Promise.reject(new Error('unreachable'))),
    );

    await close(OWNER, ticket);

    const sent = logSends() as { embeds: { description: string }[]; files: unknown[] }[];
    expect(sent).toHaveLength(2);
    expect(sent[1]?.embeds[0]?.description).toBe('Transcript unavailable');
    expect(fake.channels.get(ticket.channelId)?.delete).toHaveBeenCalledOnce();
  });

  it('marks transcripts incomplete and warns on publish when Message Content Intent is disabled', async () => {
    messageContent = false;
    const view = await publish();
    expect(lastText(view.editReply)).toContain('Message Content Intent is disabled');
    await open(OWNER);
    const ticket = await onlyTicket();

    await close(OWNER, ticket);

    const [log] = logSends() as { embeds: { description: string }[]; files: { attachment: Buffer }[] }[];
    expect(log?.embeds[0]?.description).toContain('Transcript incomplete');
    expect(log?.files[0]?.attachment.toString('utf8')).toContain('Message Content Intent is disabled');
  });

  it('re-checks protection right before deleting, after the log is written', async () => {
    await publish();
    await open(OWNER);
    const ticket = await onlyTicket();
    const log = fake.channels.get(LOG);
    const realSend = log?.send.getMockImplementation();
    log?.send.mockImplementationOnce(async (payload: Payload & { files?: unknown[] }) => {
      // Management adopts the channel as infrastructure while the close is running.
      await store.registry(GUILD).upsert({
        logicalKey: 'channel.support',
        resourceType: 'CHANNEL',
        discordId: ticket.channelId,
        channelId: null,
        managed: true,
        contentHash: null,
        configurationHash: null,
        createdByRunId: null,
        metadata: { adopted: true },
      });
      return realSend?.(payload) ?? Promise.reject(new Error('unreachable'));
    });

    await close(OWNER, ticket);

    expect(fake.channels.get(ticket.channelId)?.delete).not.toHaveBeenCalled();
    expect(JSON.stringify(logSends())).toContain('not a Xenon ticket channel');
  });

  it('keeps the channel when the log cannot be written, so nothing is lost', async () => {
    await publish();
    await open(OWNER);
    const ticket = await onlyTicket();
    fake.channels.get(LOG)?.send.mockRejectedValue(new Error('Missing Access'));
    const view = await close(OWNER, ticket);

    expect((await onlyTicket()).status).toBe('CLOSED');
    expect(fake.channels.get(ticket.channelId)?.delete).not.toHaveBeenCalled();
    expect(lastText(view.followUp)).toContain('channel was kept');
  });

  it('a double close produces one log and one delete', async () => {
    await publish();
    await open(OWNER);
    const ticket = await onlyTicket();
    const first = button(fake, 'close', OWNER, ticket);
    const second = button(fake, 'close', STAFF, ticket);

    await Promise.all([handleButton(first as never, store), handleButton(second as never, store)]);

    expect(logSends()).toHaveLength(1);
    expect(fake.channels.get(ticket.channelId)?.delete).toHaveBeenCalledOnce();
    const replies = [lastText(first.followUp), lastText(second.followUp), lastText(first.reply), lastText(second.reply)];
    expect(replies).toContain(ALREADY_CLOSING);

    const late = await close(MANAGER, ticket);
    expect(lastText(late.reply)).toBe(ALREADY_CLOSING);
    expect(logSends()).toHaveLength(1);
  });

  it('never deletes adopted or configured infrastructure, even if a record points at it', async () => {
    await publish();
    await open(OWNER);
    const ticket = await onlyTicket();
    await store.registry(GUILD).upsert({
      logicalKey: 'channel.support',
      resourceType: 'CHANNEL',
      discordId: ticket.channelId,
      channelId: null,
      managed: true,
      contentHash: null,
      configurationHash: null,
      createdByRunId: null,
      metadata: { adopted: true },
    });

    await close(OWNER, ticket);

    expect(fake.channels.get(ticket.channelId)?.delete).not.toHaveBeenCalled();
    expect(JSON.stringify(logSends())).toContain('not a Xenon ticket channel');
    for (const id of [PANEL, LOG, CATEGORY]) expect(fake.channels.get(id)?.delete).not.toHaveBeenCalled();
    for (const categoryId of Object.values((await store.getGuild(GUILD)).ticketCategories))
      expect(fake.channels.get(categoryId)?.delete).not.toHaveBeenCalled();
  });

  it('formats durations for the log', () => {
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(5 * 60_000 + 3_000)).toBe('5m 3s');
    expect(formatDuration(2 * 3_600_000 + 14 * 60_000)).toBe('2h 14m');
    expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe('3d 4h');
  });

  // ── Lifecycle, persistence and safety ────────────────────────────────────

  it('only releases an existing ticket when Discord confirms its channel was deleted', async () => {
    await publish();
    await open(OWNER);
    const ticket = await onlyTicket();
    resetTicketCooldowns();
    fake.channels.delete(ticket.channelId);
    const realFetch = fake.guild.channels.fetch.getMockImplementation();
    fake.guild.channels.fetch.mockImplementation((id: string) =>
      id === ticket.channelId
        ? Promise.reject(Object.assign(new Error('Missing Access'), { code: 50001 }))
        : (realFetch?.(id) ?? Promise.reject(new Error('unreachable'))),
    );
    const transient = await open(OWNER);

    expect(lastText(transient.editReply)).toContain('could not verify');
    expect((await onlyTicket()).status).toBe('OPEN');

    if (realFetch !== undefined) fake.guild.channels.fetch.mockImplementation(realFetch);
    const released = await open(OWNER);
    expect(lastText(released.editReply)).toContain('Ticket created');
    expect((await store.getGuild(GUILD)).tickets[ticket.ticketId]).toMatchObject({ status: 'CLOSED', closedBy: null });
  });

  it('refuses a staff role change while ticket channels still grant the previous role', async () => {
    await publish();
    await open(OWNER);
    const view = await publish({ staff_role: NEW_STAFF_ROLE });

    expect((await store.getGuild(GUILD)).ticketConfig?.ticketStaffRoleId).toBe(STAFF_ROLE);
    expect(lastText(view.editReply)).toContain('Staff role not changed');
  });

  it('moves Xenon ticket categories to a new staff role when no ticket still grants the old one', async () => {
    await publish();
    await publish({ staff_role: NEW_STAFF_ROLE });

    const state = await store.getGuild(GUILD);
    expect(state.ticketConfig?.ticketStaffRoleId).toBe(NEW_STAFF_ROLE);
    for (const categoryId of Object.values(state.ticketCategories)) {
      const category = fake.channels.get(categoryId);
      expect(category?.permissionOverwrites.delete).toHaveBeenCalledWith(STAFF_ROLE, expect.any(String));
      expect(category?.permissionOverwrites.edit).toHaveBeenCalledWith(
        NEW_STAFF_ROLE,
        expect.objectContaining({ ViewChannel: true }),
        expect.objectContaining({ type: OverwriteType.Role }),
      );
    }
  });

  it('keeps CLOSED records after the channel is deleted and reloads them after a restart', async () => {
    await publish();
    await open(OWNER);
    const ticket = await onlyTicket();

    const restarted = new JsonDiscordRuntimeStore(file);
    expect((await restarted.getGuild(GUILD)).tickets[ticket.ticketId]).toEqual(ticket);
    await handleButton(button(fake, 'close', OWNER, ticket) as never, restarted);

    expect(fake.channels.get(ticket.channelId)?.delete).toHaveBeenCalledOnce();
    const reloaded = (await new JsonDiscordRuntimeStore(file).getGuild(GUILD)).tickets[ticket.ticketId];
    expect(reloaded).toMatchObject({ ticketId: ticket.ticketId, channelId: ticket.channelId, ownerId: OWNER, status: 'CLOSED', closedBy: OWNER });
    expect(await restarted.reserveTicketId(GUILD)).toBe('XN-TK-0002');
  });

  it('loads pre-ticket, pre-claim and malformed runtime documents without losing other state', async () => {
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        guilds: {
          [GUILD]: {
            entries: [],
            features: { tempVoice: true },
            welcomeEnabled: false,
            rooms: {},
            ticketConfig: {
              ticketPanelChannelId: PANEL,
              ticketCategoryId: CATEGORY,
              ticketLogChannelId: LOG,
              ticketStaffRoleId: STAFF_ROLE,
              ticketPanelMessageId: null,
            },
            tickets: {
              'XN-TK-0007': {
                ticketId: 'XN-TK-0007',
                guildId: GUILD,
                channelId: PANEL,
                ownerId: OWNER,
                category: 'GENERAL',
                createdAt: '2026-10-06T00:00:00.000Z',
                closedAt: null,
                closedBy: null,
                status: 'OPEN',
              },
              'XN-TK-0008': { ticketId: 'XN-TK-0008', status: 'BROKEN' },
            },
          },
        },
      }),
    );

    const state = await store.getGuild(GUILD);
    expect(state.welcomeEnabled).toBe(false);
    expect(state.features).toEqual({ tempVoice: true });
    expect(state.ticketConfig).toEqual({
      ticketPanelChannelId: PANEL,
      ticketLogChannelId: LOG,
      ticketStaffRoleId: STAFF_ROLE,
      ticketPanelMessageId: null,
    });
    expect(state.ticketCategories).toEqual({});
    expect(state.tickets['XN-TK-0007']?.claimedBy).toBeNull();
    expect(Object.keys(state.tickets)).toEqual(['XN-TK-0007']);
    expect(await store.reserveTicketId(GUILD)).toBe('XN-TK-0008');
    const written = JSON.parse(await readFile(file, 'utf8')) as {
      guilds: Record<string, { tickets: Record<string, unknown> }>;
    };
    expect(written.guilds[GUILD]?.tickets['XN-TK-0008']).toBeUndefined();
  });

  it('runs without Postgres or the provisioning engine and only creates and deletes Xenon resources', async () => {
    await publish();
    await open(OWNER);
    await close(OWNER, await onlyTicket());

    expect(flags.databaseLoaded).toBe(false);
    expect(adapter.discordGuildAdapter).not.toHaveBeenCalled();
    expect(created(ChannelType.GuildCategory)).toHaveLength(TYPES.length);
    expect(ticketChannelsCreated()).toBe(1);
    expect(fake.guild.channels.create).toHaveBeenCalledTimes(TYPES.length + 1);
    expect(fake.guild.roles.create).not.toHaveBeenCalled();
    for (const method of Object.values(fake.guild.autoModerationRules)) expect(method).not.toHaveBeenCalled();
    for (const id of [PANEL, CATEGORY, LOG]) {
      const existing = fake.channels.get(id);
      for (const method of [existing?.edit, existing?.setName, existing?.setParent, existing?.setPosition, existing?.delete, existing?.permissionOverwrites.edit])
        expect(method).not.toHaveBeenCalled();
    }
  });
});
