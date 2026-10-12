import { DiscordAPIError, PermissionFlagsBits, PermissionsBitField, type Client } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { silentLogger } from '@xenon/logger';

import { createGatewayOperations, GatewayFailure } from './operations';

const GUILD = '100000000000000001';
const BOT = '200000000000000002';
const MEMBER = '300000000000000003';
const SAFE_ROLE = '400000000000000004';
const ADMIN_ROLE = '400000000000000005';
const MANAGED_ROLE = '400000000000000006';
const HIGH_ROLE = '400000000000000007';
const MODERATOR_ROLE = '400000000000000008';
const CHANNEL = '500000000000000001';
const FOREIGN_CHANNEL = '500000000000000002';
const VOICE_CHANNEL = '500000000000000003';
const MESSAGE = '600000000000000001';

function apiError(code: number, status: number): DiscordAPIError {
  return new DiscordAPIError({ code, message: 'nope' }, code, status, 'GET', '/x', {});
}

function fakeRole(id: string, position: number, permissions: bigint[] = [], managed = false) {
  return { id, position, managed, permissions: new PermissionsBitField(permissions) };
}

function fakeChannel(id: string, guildId: string | null, options: { sendable?: boolean } = {}) {
  const sendable = options.sendable ?? true;
  return {
    id,
    guildId,
    isDMBased: () => guildId === null,
    isTextBased: () => sendable,
    isSendable: () => sendable,
    send: vi.fn(() => Promise.resolve({ id: MESSAGE, channelId: id })),
    messages: { fetch: vi.fn() },
  };
}

function setup(options: { ready?: boolean; botPermissions?: bigint[] } = {}) {
  const roles = new Map([
    [GUILD, fakeRole(GUILD, 0)],
    [SAFE_ROLE, fakeRole(SAFE_ROLE, 2)],
    [ADMIN_ROLE, fakeRole(ADMIN_ROLE, 3, [PermissionFlagsBits.Administrator])],
    [MODERATOR_ROLE, fakeRole(MODERATOR_ROLE, 3, [PermissionFlagsBits.KickMembers])],
    [MANAGED_ROLE, fakeRole(MANAGED_ROLE, 3, [], true)],
    [HIGH_ROLE, fakeRole(HIGH_ROLE, 20)],
  ]);
  const botHighest = 10;
  const me = {
    roles: {
      highest: { comparePositionTo: (other: { position: number }) => botHighest - other.position },
    },
    permissions: new PermissionsBitField(
      options.botPermissions ?? [PermissionFlagsBits.ManageRoles],
    ),
  };
  const member = {
    nickname: 'Nick',
    joinedAt: new Date('2026-01-01T00:00:00.000Z'),
    pending: false,
    roles: {
      cache: new Map([[GUILD, {}]]),
      add: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    },
  };
  const guild = {
    id: GUILD,
    name: 'Xenon',
    memberCount: 10,
    iconURL: () => null,
    roles: { fetch: vi.fn((id: string) => Promise.resolve(roles.get(id) ?? null)) },
    members: {
      me,
      fetchMe: vi.fn(() => Promise.resolve(me)),
      fetch: vi.fn(({ user }: { user: string }) =>
        user === MEMBER ? Promise.resolve(member) : Promise.reject(apiError(10007, 404)),
      ),
    },
  };
  const channels = new Map([
    [CHANNEL, fakeChannel(CHANNEL, GUILD)],
    [FOREIGN_CHANNEL, fakeChannel(FOREIGN_CHANNEL, '999999999999999999')],
    [VOICE_CHANNEL, fakeChannel(VOICE_CHANNEL, GUILD, { sendable: false })],
  ]);
  const client = {
    isReady: () => options.ready ?? true,
    user: { id: BOT },
    guilds: { cache: new Map([[GUILD, guild]]), fetch: vi.fn(() => Promise.resolve(guild)) },
    channels: { fetch: vi.fn((id: string) => Promise.resolve(channels.get(id) ?? null)) },
    users: { fetch: vi.fn() },
  };
  const operations = createGatewayOperations({
    client: client as unknown as Client,
    guildId: GUILD,
    eventsChannelId: undefined,
    staffLogChannelId: CHANNEL,
    logger: silentLogger,
  });
  return { operations, member, channels };
}

async function failureOf(promise: Promise<unknown>): Promise<GatewayFailure> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(GatewayFailure);
  return error as GatewayFailure;
}

describe('gateway role policy', () => {
  const change = (roleId: string) => ({
    discordUserId: MEMBER,
    roleId,
    action: 'add' as const,
    reason: 'sync',
  });

  it('adds an ordinary role and reports the change', async () => {
    const { operations, member } = setup();
    await expect(operations['member.role'](change(SAFE_ROLE))).resolves.toEqual({ changed: true });
    expect(member.roles.add).toHaveBeenCalledWith(SAFE_ROLE, 'sync');
  });

  it('refuses privileged, managed and @everyone roles without touching the member', async () => {
    const { operations, member } = setup();
    for (const roleId of [ADMIN_ROLE, MODERATOR_ROLE, MANAGED_ROLE, GUILD]) {
      const failure = await failureOf(operations['member.role'](change(roleId)));
      expect(failure.code, roleId).toBe('FORBIDDEN_TARGET');
      expect(failure.retryable).toBe(false);
    }
    const removal = await failureOf(
      operations['member.role']({ ...change(ADMIN_ROLE), action: 'remove' }),
    );
    expect(removal.code).toBe('FORBIDDEN_TARGET');
    expect(member.roles.add).not.toHaveBeenCalled();
    expect(member.roles.remove).not.toHaveBeenCalled();
  });

  it('reports hierarchy and missing Manage Roles as Discord 50013', async () => {
    const blocked = await failureOf(setup().operations['member.role'](change(HIGH_ROLE)));
    expect(blocked).toMatchObject({ code: 'DISCORD_ERROR', discordCode: 50013 });

    const missing = await failureOf(
      setup({ botPermissions: [] }).operations['member.role'](change(SAFE_ROLE)),
    );
    expect(missing).toMatchObject({ code: 'DISCORD_ERROR', discordCode: 50013 });
  });

  it('reports an unknown role as Discord 10011', async () => {
    const failure = await failureOf(
      setup().operations['member.role'](change('400000000000000099')),
    );
    expect(failure).toMatchObject({ code: 'DISCORD_ERROR', discordCode: 10011 });
  });

  it('flags privileged and blocked roles on inspection', async () => {
    const { operations } = setup();
    await expect(operations['role.inspect']({ roleId: ADMIN_ROLE })).resolves.toMatchObject({
      roleFound: true,
      privileged: true,
    });
    await expect(operations['role.inspect']({ roleId: GUILD })).resolves.toMatchObject({
      privileged: true,
    });
    await expect(operations['role.inspect']({ roleId: HIGH_ROLE })).resolves.toEqual({
      roleFound: true,
      privileged: false,
      hierarchyBlocked: true,
      manageRolesMissing: false,
    });
    await expect(
      operations['role.inspect']({ roleId: '400000000000000099' }),
    ).resolves.toMatchObject({ roleFound: false });
  });

  it('returns null roles for a member who left the guild', async () => {
    const { operations } = setup();
    await expect(
      operations['member.roles']({ discordUserId: '300000000000000099' }),
    ).resolves.toEqual({ roleIds: null });
    await expect(operations['member.roles']({ discordUserId: MEMBER })).resolves.toEqual({
      roleIds: [GUILD],
    });
  });

  it('answers DISCORD_UNAVAILABLE before the gateway is ready', async () => {
    const failure = await failureOf(
      setup({ ready: false }).operations['member.roles']({ discordUserId: MEMBER }),
    );
    expect(failure).toMatchObject({ code: 'DISCORD_UNAVAILABLE', retryable: true });
  });
});

describe('gateway message policy', () => {
  it('always suppresses mention parsing and only allows listed role pings', async () => {
    const { operations, channels } = setup();
    await operations['message.send']({
      target: { kind: 'channel', channelId: CHANNEL },
      message: {
        content: '@everyone hello <@&400000000000000004>',
        allowedRoleMentions: [SAFE_ROLE, GUILD],
      },
    });
    await operations['message.send']({
      target: { kind: 'channel', channelId: CHANNEL },
      message: { content: 'plain' },
    });
    const send = channels.get(CHANNEL)?.send;
    expect(send).toHaveBeenNthCalledWith(1, {
      content: '@everyone hello <@&400000000000000004>',
      allowedMentions: { parse: [], roles: [SAFE_ROLE] },
    });
    expect(send).toHaveBeenNthCalledWith(2, {
      content: 'plain',
      allowedMentions: { parse: [], roles: [] },
    });
  });

  it('refuses channels outside the guild and channels that cannot hold messages', async () => {
    const { operations, channels } = setup();
    for (const channelId of [FOREIGN_CHANNEL, VOICE_CHANNEL]) {
      const failure = await failureOf(
        operations['message.send']({
          target: { kind: 'channel', channelId },
          message: { content: 'x' },
        }),
      );
      expect(failure.code, channelId).toBe('FORBIDDEN_TARGET');
    }
    expect(channels.get(FOREIGN_CHANNEL)?.send).not.toHaveBeenCalled();
  });

  it('edits only messages Link authored', async () => {
    const { operations, channels } = setup();
    const edit = vi.fn(() => Promise.resolve());
    const fetchMessage = channels.get(CHANNEL)?.messages.fetch;
    fetchMessage?.mockResolvedValueOnce({ author: { id: '700000000000000001' }, edit });
    await expect(
      operations['message.edit']({
        channelId: CHANNEL,
        messageId: MESSAGE,
        message: { content: 'x' },
      }),
    ).resolves.toEqual({ found: false });
    expect(edit).not.toHaveBeenCalled();

    fetchMessage?.mockResolvedValueOnce({ author: { id: BOT }, edit });
    await expect(
      operations['message.edit']({
        channelId: CHANNEL,
        messageId: MESSAGE,
        message: { content: 'y' },
      }),
    ).resolves.toEqual({ found: true });
    expect(edit).toHaveBeenCalledWith({
      content: 'y',
      allowedMentions: { parse: [], roles: [] },
    });

    fetchMessage?.mockRejectedValueOnce(apiError(10008, 404));
    await expect(
      operations['message.edit']({
        channelId: CHANNEL,
        messageId: MESSAGE,
        message: { content: 'z' },
      }),
    ).resolves.toEqual({ found: false });
  });

  it('refuses to edit in another guild', async () => {
    const failure = await failureOf(
      setup().operations['message.edit']({
        channelId: FOREIGN_CHANNEL,
        messageId: MESSAGE,
        message: { content: 'x' },
      }),
    );
    expect(failure.code).toBe('FORBIDDEN_TARGET');
  });
});
