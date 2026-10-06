import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChannelType, PermissionFlagsBits as P, PermissionsBitField } from 'discord.js';
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const loaded = vi.hoisted(() => ({ database: false, redis: false, queue: false }));

vi.mock('@xenon/database', () => {
  loaded.database = true;
  return {};
});
vi.mock('ioredis', () => {
  loaded.redis = true;
  return {};
});
vi.mock('bullmq', () => {
  loaded.queue = true;
  return {};
});
vi.mock('../runtime', () => ({
  botEnv: {},
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  handleWelcomeCommand,
  handleWelcomeJoin,
  initialRoleProblem,
  ordinal,
  renderWelcomeText,
  resetWelcomeDedupe,
  unknownWelcomeTokens,
  type WelcomeDeps,
} from './discord-only-welcome';
import { DEFAULT_WELCOME, JsonDiscordRuntimeStore, type WelcomeConfig } from './runtime-store';
import { CARD_HEIGHT, CARD_WIDTH, cardName, clampText, escapeXml, renderWelcomeCard } from './welcome-card';

const GUILD = '100000000000000001';
const BOT = '300000000000000001';
const MEMBER = '400000000000000001';
const ADMIN = '400000000000000002';
const WELCOME = '500000000000000001';
const RULES = '500000000000000002';
const ROLES = '500000000000000003';
const ADOPTED = '500000000000000004';
const CITIZEN = '600000000000000001';
const ADMIN_ROLE = '600000000000000002';
const MOD_ROLE = '600000000000000003';
const MANAGED_ROLE = '600000000000000004';
const HIGH_ROLE = '600000000000000005';

let avatarPng: Buffer;

beforeAll(async () => {
  avatarPng = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 40, g: 80, b: 160 } } })
    .png()
    .toBuffer();
});

function fakeChannel(id: string, name: string) {
  const message = { react: vi.fn(() => Promise.resolve()), delete: vi.fn(() => Promise.resolve()) };
  return {
    id,
    name,
    type: ChannelType.GuildText,
    guildId: GUILD,
    message,
    send: vi.fn((_payload: unknown) => Promise.resolve(message)),
    permissionsFor: vi.fn(() => ({ missing: vi.fn(() => []) })),
  };
}

function role(id: string, position: number, permissions: bigint, managed = false) {
  return { id, position, managed, guild: { id: GUILD }, permissions: new PermissionsBitField(permissions) };
}

function fakeGuild() {
  const channels = new Map(
    [
      fakeChannel(WELCOME, 'welcome'),
      fakeChannel(RULES, 'rules'),
      fakeChannel(ROLES, 'choose-roles'),
      fakeChannel(ADOPTED, 'adopted-welcome'),
    ].map((channel) => [channel.id, channel]),
  );
  const roles = new Map(
    [
      role(CITIZEN, 5, P.ViewChannel | P.SendMessages),
      role(ADMIN_ROLE, 6, P.Administrator),
      role(MOD_ROLE, 7, P.ManageMessages | P.KickMembers),
      role(MANAGED_ROLE, 3, 0n, true),
      role(HIGH_ROLE, 50, P.ViewChannel),
      role(GUILD, 0, P.ViewChannel),
    ].map((entry) => [entry.id, entry]),
  );
  const me = { id: BOT, permissions: new PermissionsBitField(P.ManageRoles), roles: { highest: { position: 20 } } };
  const guild = {
    id: GUILD,
    name: 'Xenon Roleplay',
    memberCount: 280,
    channels: {
      fetch: vi.fn((id: string) => {
        const channel = channels.get(id);
        return channel === undefined ? Promise.reject(new Error('Unknown Channel')) : Promise.resolve(channel);
      }),
    },
    roles: { fetch: vi.fn((id: string) => Promise.resolve(roles.get(id) ?? null)) },
    members: {
      fetchMe: vi.fn(() => Promise.resolve(me)),
      fetch: vi.fn((id: string) => Promise.resolve(member(guild, id, 'previewer', 'Preview Person'))),
    },
  };
  return { guild, channels, roles };
}
type Fake = ReturnType<typeof fakeGuild>;

function member(guild: Fake['guild'], id = MEMBER, username = 'jake', displayName = 'JAKE') {
  return {
    id,
    guild,
    displayName,
    user: {
      id,
      username,
      bot: false,
      displayAvatarURL: vi.fn(() => `https://cdn.discordapp.com/avatars/${id}/avatar.png?size=256`),
    },
    roles: { add: vi.fn(() => Promise.resolve()) },
    send: vi.fn(() => Promise.resolve()),
  };
}

const client = (membersIntent = true) => ({ application: { flags: { any: () => membersIntent } } });

function command(fake: Fake, subcommand: string, options: Record<string, string | boolean | number | null> = {}, membersIntent = true) {
  const value = (name: string) => (name in options ? options[name] : null);
  return {
    guild: fake.guild,
    user: { id: ADMIN },
    client: client(membersIntent),
    options: {
      getChannel: vi.fn((name: string) => (value(name) === null ? null : { id: value(name) })),
      getRole: vi.fn((name: string) => (value(name) === null ? null : { id: value(name) })),
      getBoolean: vi.fn((name: string) => value(name)),
      getInteger: vi.fn((name: string) => value(name)),
      getString: vi.fn((name: string) => value(name)),
    },
    reply: vi.fn((_payload: unknown) => Promise.resolve()),
    deferReply: vi.fn((_payload: unknown) => Promise.resolve()),
    editReply: vi.fn((_payload: unknown) => Promise.resolve()),
  };
}

function text(mock: { mock: { calls: unknown[][] } }): string {
  const value = mock.mock.calls.at(-1)?.[0];
  return typeof value === 'string' ? value : ((value as { content?: string } | undefined)?.content ?? '');
}

interface SentPayload {
  content: string;
  files: { name: string; attachment: Buffer }[];
  allowedMentions: unknown;
}

describe('discord-only Xenon welcome', () => {
  let directory = '';
  let store: JsonDiscordRuntimeStore;
  let fake: Fake;
  let deps: WelcomeDeps;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-welcome-'));
    store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    fake = fakeGuild();
    resetWelcomeDedupe();
    deps = { fetchAvatar: vi.fn(() => Promise.resolve(avatarPng)), renderCard: vi.fn(renderWelcomeCard) };
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  });

  async function configure(patch: Partial<WelcomeConfig> = {}) {
    await store.saveWelcomeConfig(GUILD, {
      ...DEFAULT_WELCOME,
      channelId: WELCOME,
      rulesChannelId: RULES,
      rolesChannelId: ROLES,
      ...patch,
    });
  }

  async function welcomeJoin(target = member(fake.guild)) {
    await handleWelcomeJoin(target as never, store, deps);
    return target;
  }

  const sent = (id = WELCOME) => fake.channels.get(id)?.send.mock.calls.map(([payload]) => payload as SentPayload) ?? [];

  // ── Join ────────────────────────────────────────────────────────────────

  it('posts exactly one welcome per join, even if Discord delivers the event twice', async () => {
    await configure();
    const target = member(fake.guild);
    await welcomeJoin(target);
    await welcomeJoin(target);

    expect(sent()).toHaveLength(1);
    expect(fake.channels.get(WELCOME)?.message.react).toHaveBeenCalledWith('💚');
  });

  it('sends nothing at all when welcomes are disabled', async () => {
    await configure({ enabled: false, dmEnabled: true, initialRoleId: CITIZEN });
    const target = await welcomeJoin();

    for (const channel of fake.channels.values()) expect(channel.send).not.toHaveBeenCalled();
    expect(target.send).not.toHaveBeenCalled();
    expect(target.roles.add).not.toHaveBeenCalled();
  });

  it('uses the configured channel over the adopted channel.welcome', async () => {
    await configure();
    await store.registry(GUILD).upsert(adoptedWelcome());
    await welcomeJoin();

    expect(sent()).toHaveLength(1);
    expect(sent(ADOPTED)).toHaveLength(0);
  });

  it('falls back to the adopted channel.welcome when no channel is configured', async () => {
    await store.registry(GUILD).upsert(adoptedWelcome());
    await welcomeJoin();

    expect(sent(ADOPTED)).toHaveLength(1);
  });

  it('skips the public welcome and keeps going when the configured channel disappeared', async () => {
    await configure({ initialRoleId: CITIZEN });
    fake.channels.delete(WELCOME);
    const target = await welcomeJoin();

    expect(target.roles.add).toHaveBeenCalledOnce();
  });

  it('renders the default text with safe mentions, member count and both channel links', async () => {
    await configure();
    await welcomeJoin();

    const [payload] = sent();
    expect(payload?.content).toBe(
      [
        `👋 **Welcome <@${MEMBER}> to Xenon Roleplay!**`,
        '',
        `Make sure to check out <#${RULES}> and pick your roles in <#${ROLES}>.`,
        '',
        'You are our **280th member**!',
        'Enjoy your roleplay experience in Xenon. 💚',
      ].join('\n'),
    );
    expect(payload?.allowedMentions).toEqual({ users: [MEMBER], roles: [], parse: [] });
  });

  it('omits missing optional channels and the member count cleanly', () => {
    const base = { memberId: MEMBER, username: 'jake', displayName: 'JAKE', guildName: 'Xenon', memberCount: null };
    const none = renderWelcomeText({ ...DEFAULT_WELCOME }, base);
    expect(none).toBe(`👋 **Welcome <@${MEMBER}> to Xenon Roleplay!**\n\nEnjoy your roleplay experience in Xenon. 💚`);
    expect(renderWelcomeText({ ...DEFAULT_WELCOME, rulesChannelId: RULES }, base)).toContain(`Make sure to check out <#${RULES}>.`);
    expect(renderWelcomeText({ ...DEFAULT_WELCOME, rolesChannelId: ROLES }, base)).toContain(`Pick your roles in <#${ROLES}>.`);
    for (const rendered of [none, renderWelcomeText({ ...DEFAULT_WELCOME, rulesChannelId: RULES }, base)])
      expect(rendered).not.toMatch(/undefined|null|<#>|member\*\*!/);
    expect(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '280th', '1002nd'].map((value) => ordinal(Number.parseInt(value, 10)))).toEqual(
      ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '280th', '1002nd'],
    );
  });

  it('substitutes only whitelisted custom tokens and escapes member-controlled text', () => {
    const rendered = renderWelcomeText(
      { ...DEFAULT_WELCOME, customMessage: 'Hi {mention} aka {displayName} on {server} #{memberCount} {rulesChannel}{rolesChannel}' },
      { memberId: MEMBER, username: 'jake', displayName: '@everyone **bold**', guildName: 'Xenon', memberCount: 280 },
    );
    expect(rendered).toBe(`Hi <@${MEMBER}> aka @everyone \\*\\*bold\\*\\* on Xenon #280 `);
    expect(unknownWelcomeTokens('Hi {mention} {constructor} {process.env}')).toEqual(['constructor', 'process.env']);
  });

  it('attaches a generated 1000×360 welcome.png', async () => {
    await configure();
    await welcomeJoin();

    const [payload] = sent();
    expect(payload?.files[0]?.name).toBe('welcome.png');
    const metadata = await sharp(payload?.files[0]?.attachment).metadata();
    expect([metadata.format, metadata.width, metadata.height]).toEqual(['png', CARD_WIDTH, CARD_HEIGHT]);
    expect(deps.renderCard).toHaveBeenCalledWith(expect.objectContaining({ name: 'JAKE', memberCount: 280 }));
  });

  it('still renders the card with the neutral avatar when the avatar cannot be fetched or decoded', async () => {
    await configure();
    deps = { ...deps, fetchAvatar: vi.fn(() => Promise.reject(new Error('timeout'))) };
    await welcomeJoin();
    expect(sent()[0]?.files[0]?.name).toBe('welcome.png');

    const corrupt = await renderWelcomeCard({ avatar: Buffer.from('not an image'), name: 'x', memberCount: 1 });
    expect((await sharp(corrupt).metadata()).width).toBe(CARD_WIDTH);
  });

  it('sends the text welcome when card rendering fails', async () => {
    await configure();
    deps = { ...deps, renderCard: vi.fn(() => Promise.reject(new Error('sharp exploded'))) };
    await welcomeJoin();

    const [payload] = sent();
    expect(payload?.content).toContain(`<@${MEMBER}>`);
    expect(payload?.files).toEqual([]);
  });

  it('truncates long names and escapes markup before rendering', async () => {
    expect(clampText('a'.repeat(80), 24)).toHaveLength(24);
    expect(clampText('a'.repeat(80), 24).endsWith('…')).toBe(true);
    expect(clampText('line\nbreak\u200b\u0007', 24)).toBe('line break');
    expect(cardName('Ж日本 名前', 'jake.dev')).toBe('jake.dev');
    expect(cardName('JAKE', 'jake')).toBe('JAKE');

    const hostile = '</text><script>alert(1)</script><image href="file:///etc/passwd"/>&';
    expect(escapeXml(hostile)).not.toMatch(/[<>"]/);
    expect(escapeXml(hostile)).toContain('&lt;/text&gt;');
    const card = await renderWelcomeCard({ avatar: null, name: hostile, memberCount: 280 });
    expect((await sharp(card).metadata()).height).toBe(CARD_HEIGHT);
  });

  // ── Roles ───────────────────────────────────────────────────────────────

  it('assigns a safe initial role', async () => {
    await configure({ initialRoleId: CITIZEN });
    const target = await welcomeJoin();

    expect(target.roles.add).toHaveBeenCalledWith(fake.roles.get(CITIZEN), expect.any(String));
  });

  it('rejects admin, moderation, managed, @everyone and too-high roles', async () => {
    const state = { ticketConfig: null };
    for (const id of [ADMIN_ROLE, MOD_ROLE, MANAGED_ROLE, GUILD, HIGH_ROLE])
      expect(await initialRoleProblem(fake.guild as never, fake.roles.get(id) as never, state), id).not.toBeNull();
    expect(await initialRoleProblem(fake.guild as never, fake.roles.get(CITIZEN) as never, state)).toBeNull();

    const view = command(fake, 'configure', { channel: WELCOME, initial_role: ADMIN_ROLE });
    await handleWelcomeCommand(view as never, fake.guild as never, store, 'configure', deps);
    expect(text(view.editReply)).toContain('Nothing was saved.');
    expect((await store.getGuild(GUILD)).welcome.channelId).toBeNull();
  });

  it('never assigns a role that became unsafe after configuration', async () => {
    await configure({ initialRoleId: MOD_ROLE });
    const target = await welcomeJoin();

    expect(target.roles.add).not.toHaveBeenCalled();
    expect(sent()).toHaveLength(1);
  });

  it('keeps the welcome when role assignment fails', async () => {
    await configure({ initialRoleId: CITIZEN });
    const target = member(fake.guild);
    target.roles.add.mockRejectedValue(new Error('Missing Permissions'));
    await welcomeJoin(target);

    expect(sent()).toHaveLength(1);
  });

  // ── DM ──────────────────────────────────────────────────────────────────

  it('sends the welcome DM when enabled and survives closed DMs', async () => {
    await configure({ dmEnabled: true });
    const target = member(fake.guild);
    await welcomeJoin(target);
    expect(JSON.stringify(target.send.mock.calls[0])).toContain('👋 WELCOME TO XENON ROLEPLAY');
    expect(JSON.stringify(target.send.mock.calls[0])).toContain(`<#${RULES}>`);

    resetWelcomeDedupe();
    const closed = member(fake.guild, '400000000000000009');
    closed.send.mockRejectedValue(Object.assign(new Error('Cannot send messages to this user'), { code: 50007 }));
    await expect(welcomeJoin(closed)).resolves.toBeDefined();
    expect(sent()).toHaveLength(2);
  });

  // ── Auto delete ─────────────────────────────────────────────────────────

  it('deletes the welcome after delete_after seconds, and never when 0', async () => {
    vi.useFakeTimers();
    await configure({ deleteAfterSeconds: 30, generateCard: false });
    await welcomeJoin();
    const message = fake.channels.get(WELCOME)?.message;
    await vi.advanceTimersByTimeAsync(29_000);
    expect(message?.delete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(message?.delete).toHaveBeenCalledOnce();
  });

  // ── Commands ────────────────────────────────────────────────────────────

  it('configure stores native selections and validates custom tokens', async () => {
    const bad = command(fake, 'configure', { channel: WELCOME, message: 'Hi {mention} {token}' });
    await handleWelcomeCommand(bad as never, fake.guild as never, store, 'configure', deps);
    expect(text(bad.editReply)).toContain('{token}');
    expect((await store.getGuild(GUILD)).welcome.channelId).toBeNull();

    const view = command(fake, 'configure', {
      channel: WELCOME,
      rules_channel: RULES,
      roles_channel: ROLES,
      initial_role: CITIZEN,
      dm_enabled: true,
      show_member_count: true,
      generate_card: true,
      delete_after: 0,
    });
    await handleWelcomeCommand(view as never, fake.guild as never, store, 'configure', deps);
    expect((await store.getGuild(GUILD)).welcome).toEqual({
      ...DEFAULT_WELCOME,
      channelId: WELCOME,
      rulesChannelId: RULES,
      rolesChannelId: ROLES,
      initialRoleId: CITIZEN,
      dmEnabled: true,
    });
    expect(text(view.editReply)).toContain('READY');
  });

  it('preview renders privately with the caller and changes nothing', async () => {
    await configure({ initialRoleId: CITIZEN, dmEnabled: true });
    const before = await store.getGuild(GUILD);
    const previewer = member(fake.guild, ADMIN, 'previewer', 'Preview Person');
    fake.guild.members.fetch.mockResolvedValue(previewer);
    const view = command(fake, 'preview');

    await handleWelcomeCommand(view as never, fake.guild as never, store, 'preview', deps);

    const reply = view.editReply.mock.calls[0]?.[0] as SentPayload;
    expect(reply.content).toContain(`<@${ADMIN}>`);
    expect(reply.content).toContain('280');
    expect(reply.files[0]?.name).toBe('welcome.png');
    expect(reply.allowedMentions).toEqual({ parse: [] });
    for (const channel of fake.channels.values()) expect(channel.send).not.toHaveBeenCalled();
    expect(previewer.roles.add).not.toHaveBeenCalled();
    expect(previewer.send).not.toHaveBeenCalled();
    expect(fake.guild.memberCount).toBe(280);
    expect(await store.getGuild(GUILD)).toEqual(before);
  });

  it('status reports the configuration and readiness accurately', async () => {
    const empty = command(fake, 'status');
    await handleWelcomeCommand(empty as never, fake.guild as never, store, 'status', deps);
    expect(text(empty.reply)).toContain('NOT READY — configure a welcome channel.');

    await configure({ initialRoleId: CITIZEN, dmEnabled: true });
    const ready = command(fake, 'status');
    await handleWelcomeCommand(ready as never, fake.guild as never, store, 'status', deps);
    const summary = text(ready.reply);
    for (const line of [
      'Status: ENABLED',
      `Channel: <#${WELCOME}>`,
      `Rules: <#${RULES}>`,
      `Roles: <#${ROLES}>`,
      `Initial role: <@&${CITIZEN}>`,
      'Welcome card: ON',
      'Member count: ON',
      'DM welcome: ON',
      'Auto delete: OFF',
    ])
      expect(summary).toContain(line);
    expect(summary.trim().endsWith('READY')).toBe(true);

    const noIntent = command(fake, 'status', {}, false);
    await handleWelcomeCommand(noIntent as never, fake.guild as never, store, 'status', deps);
    expect(text(noIntent.reply)).toContain('Server Members Intent');

    await handleWelcomeCommand(command(fake, 'disable') as never, fake.guild as never, store, 'disable', deps);
    const disabled = command(fake, 'status');
    await handleWelcomeCommand(disabled as never, fake.guild as never, store, 'status', deps);
    expect(text(disabled.reply)).toContain('Status: DISABLED');
  });

  // ── Persistence and isolation ───────────────────────────────────────────

  it('migrates old welcomeEnabled/welcomeDmEnabled runtime documents', async () => {
    const file = join(directory, 'legacy.json');
    await writeFile(
      file,
      JSON.stringify({ version: 1, guilds: { [GUILD]: { entries: [], features: {}, welcomeEnabled: false, welcomeDmEnabled: true } } }),
    );
    const legacy = new JsonDiscordRuntimeStore(file);
    expect((await legacy.getGuild(GUILD)).welcome).toEqual({ ...DEFAULT_WELCOME, enabled: false, dmEnabled: true });

    await legacy.saveWelcomeConfig(GUILD, { ...DEFAULT_WELCOME, channelId: WELCOME });
    expect((await new JsonDiscordRuntimeStore(file).getGuild(GUILD)).welcome.channelId).toBe(WELCOME);
  });

  it('runs without Postgres, Redis or a job queue', async () => {
    await configure({ initialRoleId: CITIZEN, dmEnabled: true, deleteAfterSeconds: 5 });
    await welcomeJoin();

    expect(loaded).toEqual({ database: false, redis: false, queue: false });
  });
});

function adoptedWelcome() {
  return {
    logicalKey: 'channel.welcome',
    resourceType: 'CHANNEL' as const,
    discordId: ADOPTED,
    channelId: null,
    managed: true,
    contentHash: null,
    configurationHash: null,
    createdByRunId: null,
    metadata: { adopted: true },
  };
}
