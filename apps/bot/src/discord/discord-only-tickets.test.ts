import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChannelType, OverwriteType, PermissionFlagsBits as P } from 'discord.js';
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
import { resetTicketCooldowns } from './discord-only-tickets';
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

let sequence = 900000000000000000n;
const nextId = () => String((sequence += 1n));

interface FakeMessage {
  id: string;
  channelId: string;
  author: { id: string };
  payload: unknown;
  edit: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function fakeChannel(id: string, name: string, type: ChannelType) {
  const messages = new Map<string, FakeMessage>();
  const channel = {
    id,
    name,
    type,
    guildId: GUILD,
    createOptions: undefined as unknown,
    messages: {
      store: messages,
      fetch: vi.fn((messageId: string) => {
        const message = messages.get(messageId);
        return message === undefined
          ? Promise.reject(Object.assign(new Error('Unknown Message'), { code: 10008 }))
          : Promise.resolve(message);
      }),
    },
    permissionsFor: vi.fn(() => ({ missing: vi.fn(() => []) })),
    send: vi.fn((payload: unknown) => {
      const message: FakeMessage = {
        id: nextId(),
        channelId: id,
        author: { id: BOT },
        payload,
        edit: vi.fn((next: unknown) => {
          message.payload = next;
          return Promise.resolve(message);
        }),
        delete: vi.fn(() => Promise.resolve()),
      };
      messages.set(message.id, message);
      return Promise.resolve(message);
    }),
    permissionOverwrites: { cache: new Map<string, unknown>(), edit: vi.fn(() => Promise.resolve()) },
    setName: vi.fn((next: string) => {
      channel.name = next;
      return Promise.resolve(channel);
    }),
    edit: vi.fn(),
    setParent: vi.fn(),
    setPosition: vi.fn(),
    delete: vi.fn(() => Promise.resolve()),
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
    channels: {
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
        Promise.resolve(
          id === STAFF_ROLE || id === NEW_STAFF_ROLE ? { id, guild: { id: GUILD } } : null,
        ),
      ),
      create: vi.fn(),
    },
    members: {
      fetchMe: vi.fn(() => Promise.resolve({ id: BOT })),
      fetch: vi.fn((id: string) => Promise.resolve({ id, roles: { cache: new Set(memberRoles.get(id) ?? []) } })),
    },
    autoModerationRules: { fetch: vi.fn(), create: vi.fn(), edit: vi.fn() },
  };
  return { guild, channels };
}
type Fake = ReturnType<typeof fakeGuild>;

function slash(fake: Fake, subcommand: string, picks: Partial<Record<string, string>> = {}) {
  const ids: Record<string, string> = {
    panel_channel: PANEL,
    ticket_category: CATEGORY,
    log_channel: LOG,
    staff_role: STAFF_ROLE,
    ...picks,
  };
  return {
    commandName: 'xenon',
    guild: fake.guild,
    user: { id: MANAGER },
    memberPermissions: { has: (bit: bigint) => bit === P.ManageGuild },
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
    customId: 'xn:ticket:open',
    guild: fake.guild,
    channelId: PANEL,
    message: { id: messageId },
    user: { id: userId, username: 'Player.One!' },
    values: [value],
    deferReply: vi.fn(() => Promise.resolve()),
    editReply: vi.fn(() => Promise.resolve()),
    reply: vi.fn(() => Promise.resolve()),
  };
}

function closeButton(fake: Fake, userId: string, ticket: TicketRecord, channelId = ticket.channelId) {
  return {
    customId: `xn:ticket:close:${ticket.ticketId}`,
    guild: fake.guild,
    channelId,
    user: { id: userId },
    memberPermissions: { has: (bit: bigint) => userId === MANAGER && bit === P.ManageGuild },
    reply: vi.fn(() => Promise.resolve()),
    deferUpdate: vi.fn(() => Promise.resolve()),
    editReply: vi.fn(() => Promise.resolve()),
    followUp: vi.fn(() => Promise.resolve()),
  };
}

function lastText(mock: { mock: { calls: unknown[][] } }): string {
  const value = mock.mock.calls.at(-1)?.[0];
  return typeof value === 'string' ? value : ((value as { content?: string } | undefined)?.content ?? '');
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
    resetTicketCooldowns();
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

  async function open(userId: string) {
    const view = select(fake, userId, await panelMessageId());
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

  it('registers ManageGuild /xenon tickets publish and status with required native options', () => {
    const xenon = DISCORD_ONLY_COMMANDS.find((command) => command.name === 'xenon');
    expect(xenon?.default_member_permissions).toBe(String(P.ManageGuild));
    const tickets = xenon?.options?.find((option) => option.name === 'tickets');
    const subcommands = tickets !== undefined && 'options' in tickets ? (tickets.options ?? []) : [];
    expect(subcommands.map((sub) => sub.name)).toEqual(['publish', 'status']);
    const publishOptions = subcommands[0] !== undefined && 'options' in subcommands[0] ? (subcommands[0].options ?? []) : [];
    expect(publishOptions.map((option) => [option.name, option.required])).toEqual([
      ['panel_channel', true],
      ['ticket_category', true],
      ['log_channel', true],
      ['staff_role', true],
    ]);
  });

  it('publish stores the selected existing ids and posts one Xenon panel', async () => {
    const view = await publish();

    const config = (await store.getGuild(GUILD)).ticketConfig;
    const panel = fake.channels.get(PANEL);
    expect(panel?.send).toHaveBeenCalledOnce();
    expect(config).toEqual({
      ticketPanelChannelId: PANEL,
      ticketCategoryId: CATEGORY,
      ticketLogChannelId: LOG,
      ticketStaffRoleId: STAFF_ROLE,
      ticketPanelMessageId: [...(panel?.messages.store.keys() ?? [])][0],
    });
    expect(JSON.stringify(panel?.send.mock.calls[0])).toContain('XENON SUPPORT CENTER');
    expect(lastText(view.editReply)).toContain('No channels or roles were created or modified.');
    expect(fake.guild.channels.create).not.toHaveBeenCalled();
  });

  it('publish edits the existing panel instead of posting a duplicate', async () => {
    await publish();
    const first = await panelMessageId();
    await publish();

    const panel = fake.channels.get(PANEL);
    expect(panel?.send).toHaveBeenCalledOnce();
    expect(panel?.messages.store.get(first)?.edit).toHaveBeenCalledOnce();
    expect(await panelMessageId()).toBe(first);
  });

  it('moving the panel removes the old Xenon panel so only one stays live', async () => {
    await publish();
    const first = await panelMessageId();
    await publish({ panel_channel: OTHER_PANEL });

    expect(fake.channels.get(PANEL)?.messages.store.get(first)?.delete).toHaveBeenCalledOnce();
    expect(fake.channels.get(OTHER_PANEL)?.send).toHaveBeenCalledOnce();
  });

  it('publish rejects a category supplied as a text channel and saves nothing', async () => {
    const view = await publish({ ticket_category: LOG });

    expect((await store.getGuild(GUILD)).ticketConfig).toBeNull();
    expect(fake.channels.get(PANEL)?.send).not.toHaveBeenCalled();
    expect(lastText(view.editReply)).toContain('Nothing was saved.');
  });

  it('creates exactly one private channel with owner, staff and bot overwrites', async () => {
    await publish();
    const view = await open(OWNER);

    expect(fake.guild.channels.create).toHaveBeenCalledOnce();
    const ticket = await onlyTicket();
    const created = fake.channels.get(ticket.channelId);
    const options = created?.createOptions as {
      name: string;
      parent: string;
      type: ChannelType;
      permissionOverwrites: { id: string; type: OverwriteType; allow?: bigint[]; deny?: bigint[] }[];
    };
    expect(options.type).toBe(ChannelType.GuildText);
    expect(options.parent).toBe(CATEGORY);
    expect(options.name).toBe('ticket-player-one-0001');
    const overwrite = (id: string) => options.permissionOverwrites.find((entry) => entry.id === id);

    // @everyone cannot view.
    expect(overwrite(GUILD)).toMatchObject({ type: OverwriteType.Role, deny: [P.ViewChannel] });
    expect(overwrite(GUILD)?.allow).toBeUndefined();
    // Owner can view and send.
    expect(overwrite(OWNER)).toMatchObject({ type: OverwriteType.Member });
    expect(overwrite(OWNER)?.allow).toEqual(
      expect.arrayContaining([P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles]),
    );
    // Staff role can view and send.
    expect(overwrite(STAFF_ROLE)).toMatchObject({ type: OverwriteType.Role });
    expect(overwrite(STAFF_ROLE)?.allow).toEqual(
      expect.arrayContaining([P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageMessages]),
    );
    // Nobody else, and never Administrator.
    expect(options.permissionOverwrites.map((entry) => entry.id).sort()).toEqual([BOT, GUILD, OWNER, STAFF_ROLE].sort());
    expect(options.permissionOverwrites.flatMap((entry) => entry.allow ?? [])).not.toContain(P.Administrator);

    expect(ticket).toMatchObject({ ticketId: 'XN-TK-0001', ownerId: OWNER, status: 'OPEN', closedAt: null });
    expect(JSON.stringify(created?.send.mock.calls[0])).toContain('XENON SUPPORT · TICKET OPENED');
    expect(lastText(view.editReply)).toBe(`Ticket created: <#${ticket.channelId}>`);
  });

  it('rejects a second open ticket for the same user', async () => {
    await publish();
    await open(OWNER);
    resetTicketCooldowns();
    const second = await open(OWNER);

    expect(fake.guild.channels.create).toHaveBeenCalledOnce();
    expect(lastText(second.editReply)).toContain('You already have an open ticket');
  });

  it('rate limits ticket creation per user', async () => {
    await publish();
    await open(OWNER);
    const ticket = await onlyTicket();
    await handleButton(closeButton(fake, OWNER, ticket) as never, store);
    const again = await open(OWNER);

    expect(fake.guild.channels.create).toHaveBeenCalledOnce();
    expect(lastText(again.editReply)).toContain('Please wait');
  });

  it('rejects selections from a stale or foreign panel message', async () => {
    await publish();
    const view = select(fake, OWNER, '999999999999999999');
    await handleSelect(view as never, store);

    expect(fake.guild.channels.create).not.toHaveBeenCalled();
    expect(lastText(view.editReply)).toContain('no longer active');
  });

  it('another user cannot close somebody else’s ticket', async () => {
    await publish();
    await open(OWNER);
    const ticket = await onlyTicket();
    const view = closeButton(fake, OTHER, ticket);
    await handleButton(view as never, store);

    expect((await onlyTicket()).status).toBe('OPEN');
    expect(view.deferUpdate).not.toHaveBeenCalled();
    expect(fake.channels.get(ticket.channelId)?.permissionOverwrites.edit).not.toHaveBeenCalled();
    expect(lastText(view.reply)).toContain('Only the ticket owner');
  });

  it('rejects a close button pressed outside the ticket channel', async () => {
    await publish();
    await open(OWNER);
    const ticket = await onlyTicket();
    await handleButton(closeButton(fake, OWNER, ticket, PANEL) as never, store);

    expect((await onlyTicket()).status).toBe('OPEN');
  });

  it('owner can close: persists CLOSED, locks sending, keeps viewing, renames and logs', async () => {
    await publish();
    await open(OWNER);
    const ticket = await onlyTicket();
    const view = closeButton(fake, OWNER, ticket);
    await handleButton(view as never, store);

    const closed = await onlyTicket();
    expect(closed).toMatchObject({ status: 'CLOSED', closedBy: OWNER });
    expect(closed.closedAt).not.toBeNull();
    expect(view.editReply).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
    const channel = fake.channels.get(ticket.channelId);
    expect(channel?.permissionOverwrites.edit).toHaveBeenCalledWith(
      OWNER,
      {
        ViewChannel: true,
        SendMessages: false,
        SendMessagesInThreads: false,
        CreatePublicThreads: false,
        CreatePrivateThreads: false,
      },
      expect.objectContaining({ type: OverwriteType.Member }),
    );
    expect(channel?.setName).toHaveBeenCalledWith('closed-xn-tk-0001', expect.any(String));
    expect(channel?.delete).not.toHaveBeenCalled();

    const log = fake.channels.get(LOG);
    expect(log?.send).toHaveBeenCalledOnce();
    const logged = JSON.stringify(log?.send.mock.calls[0]);
    for (const expected of ['XN-TK-0001', OWNER, 'General Support', 'Opened', 'Closed by', ticket.channelId])
      expect(logged).toContain(expected);
    expect(view.followUp).not.toHaveBeenCalled();
  });

  it('keeps the ticket OPEN and retryable when the owner cannot be locked', async () => {
    await publish();
    await open(OWNER);
    const ticket = await onlyTicket();
    const channel = fake.channels.get(ticket.channelId);
    channel?.permissionOverwrites.edit.mockRejectedValueOnce(new Error('Missing Permissions'));
    const failed = closeButton(fake, OWNER, ticket);
    await handleButton(failed as never, store);

    expect((await onlyTicket()).status).toBe('OPEN');
    expect(lastText(failed.followUp)).toContain('still open');
    expect(failed.editReply).not.toHaveBeenCalled();

    await handleButton(closeButton(fake, OWNER, ticket) as never, store);
    expect((await onlyTicket()).status).toBe('CLOSED');
  });

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
    expect(fake.guild.channels.create).toHaveBeenCalledOnce();

    if (realFetch !== undefined) fake.guild.channels.fetch.mockImplementation(realFetch);
    const released = await open(OWNER);
    expect(lastText(released.editReply)).toContain('Ticket created');
    expect((await store.getGuild(GUILD)).tickets[ticket.ticketId]).toMatchObject({ status: 'CLOSED', closedBy: null });
  });

  it('refuses to create tickets when the configured log channel disappears', async () => {
    await publish();
    fake.channels.delete(LOG);
    const view = await open(OWNER);

    expect(fake.guild.channels.create).not.toHaveBeenCalled();
    expect(lastText(view.editReply)).toContain('/xenon tickets publish');
  });

  it('refuses a staff role change while ticket channels still grant the previous role', async () => {
    await publish();
    await open(OWNER);
    const view = await publish({ staff_role: NEW_STAFF_ROLE });

    expect((await store.getGuild(GUILD)).ticketConfig?.ticketStaffRoleId).toBe(STAFF_ROLE);
    expect(lastText(view.editReply)).toContain('Staff role not changed');
  });

  it('staff role members and ManageGuild users can close', async () => {
    await publish();
    await open(OWNER);
    await handleButton(closeButton(fake, STAFF, await onlyTicket()) as never, store);
    expect(await onlyTicket()).toMatchObject({ status: 'CLOSED', closedBy: STAFF });

    resetTicketCooldowns();
    await open(OTHER);
    const second = Object.values((await store.getGuild(GUILD)).tickets).find((ticket) => ticket.ownerId === OTHER);
    if (second === undefined) throw new Error('second ticket missing');
    await handleButton(closeButton(fake, MANAGER, second) as never, store);
    expect((await store.getGuild(GUILD)).tickets[second.ticketId]).toMatchObject({ status: 'CLOSED', closedBy: MANAGER });
  });

  it('reloads ticket state from JSON after a restart', async () => {
    await publish();
    await open(OWNER);
    const ticket = await onlyTicket();

    const restarted = new JsonDiscordRuntimeStore(file);
    expect((await restarted.getGuild(GUILD)).tickets[ticket.ticketId]).toEqual(ticket);
    await handleButton(closeButton(fake, OWNER, ticket) as never, restarted);
    expect((await new JsonDiscordRuntimeStore(file).getGuild(GUILD)).tickets[ticket.ticketId]?.status).toBe('CLOSED');
    expect(await restarted.reserveTicketId(GUILD)).toBe('XN-TK-0002');
  });

  it('loads pre-ticket and malformed runtime documents without losing other state', async () => {
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
            ticketConfig: { ticketPanelChannelId: 'not-a-snowflake' },
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
    expect(state.ticketConfig).toBeNull();
    expect(Object.keys(state.tickets)).toEqual(['XN-TK-0007']);
    // The counter never reissues a reference that exists on disk.
    expect(await store.reserveTicketId(GUILD)).toBe('XN-TK-0008');
    const written = JSON.parse(await readFile(file, 'utf8')) as {
      guilds: Record<string, { tickets: Record<string, unknown> }>;
    };
    expect(written.guilds[GUILD]?.tickets['XN-TK-0008']).toBeUndefined();
  });

  it('runs without Postgres or the provisioning engine and only creates the ticket channel', async () => {
    await publish();
    await open(OWNER);
    await handleButton(closeButton(fake, OWNER, await onlyTicket()) as never, store);

    expect(flags.databaseLoaded).toBe(false);
    expect(adapter.discordGuildAdapter).not.toHaveBeenCalled();
    expect(fake.guild.channels.create).toHaveBeenCalledOnce();
    expect(fake.guild.roles.create).not.toHaveBeenCalled();
    for (const method of Object.values(fake.guild.autoModerationRules)) expect(method).not.toHaveBeenCalled();
    for (const id of [PANEL, CATEGORY, LOG]) {
      const existing = fake.channels.get(id);
      for (const method of [existing?.edit, existing?.setName, existing?.setParent, existing?.setPosition, existing?.delete, existing?.permissionOverwrites.edit])
        expect(method).not.toHaveBeenCalled();
    }
  });
});
