import { EmbedBuilder, type GuildMember } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  managedRole: vi.fn(),
  linkedAccount: vi.fn(),
  enqueue: vi.fn(),
  logger: { warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@xenon/database', () => ({
  prisma: {
    systemSetting: { findMany: mocks.settings },
    discordManagedResource: { findUnique: mocks.managedRole },
    discordAccount: { findUnique: mocks.linkedAccount },
  },
}));
vi.mock('@xenon/jobs', () => ({ enqueueBestEffort: mocks.enqueue }));
vi.mock('@xenon/discord', () => ({
  XenonBasePanel: ({ title, description }: { title: string; description: string }) =>
    new EmbedBuilder().setColor(0x2afd23).setTitle(title).setDescription(description),
}));
vi.mock('../runtime', () => ({
  botEnv: {
    DISCORD_GUILD_ID: 'guild-id',
    NEXT_PUBLIC_SITE_URL: 'https://xenon.example.test',
    NODE_ENV: 'test',
  },
  logger: mocks.logger,
}));

import { handleMemberJoin } from './welcome';

function row(key: string, value: unknown) {
  return { key, value };
}

function makeMember() {
  const publicSend = vi.fn().mockResolvedValue({ channelId: 'welcome-channel', id: 'message-id' });
  const publicChannel = { isSendable: () => true, send: publicSend };
  const privateSend = vi.fn().mockResolvedValue(undefined);
  const roleAdd = vi.fn();
  const member = {
    id: 'discord-member',
    guild: {
      id: 'guild-id',
      channels: { fetch: vi.fn().mockResolvedValue(publicChannel) },
      roles: { fetch: vi.fn() },
    },
    roles: { add: roleAdd },
    send: privateSend,
  } as unknown as GuildMember;
  return { member, publicSend, privateSend, roleAdd };
}

describe('member welcome event', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings.mockResolvedValue([
      row('discord.welcome.enabled', true),
      row('discord.welcome.publicEnabled', true),
      row('discord.welcome.dmEnabled', true),
      row('discord.welcome.channelId', 'welcome-channel'),
      row('discord.welcome.personalized', true),
      row('discord.welcome.deleteAfterSeconds', 0),
    ]);
    mocks.linkedAccount.mockResolvedValue({
      user: { publicId: 'XN-1042', whitelistState: 'APPROVED' },
    });
    mocks.enqueue.mockResolvedValue(undefined);
  });

  it('posts a short public welcome and keeps Xenon account details in the private DM', async () => {
    const view = makeMember();

    await handleMemberJoin(view.member);

    const publicPayload = view.publicSend.mock.calls[0]?.[0] as {
      content: string;
      allowedMentions: { users: string[]; roles: string[]; parse: string[] };
    };
    expect(publicPayload.content).toContain('<@discord-member>');
    expect(publicPayload.content).toContain('#rules, #how-to-join and #whitelist-info');
    expect(publicPayload.allowedMentions).toEqual({
      users: ['discord-member'],
      roles: [],
      parse: [],
    });
    expect(publicPayload.content).not.toContain('XN-1042');

    const privatePayload = view.privateSend.mock.calls[0]?.[0] as {
      embeds: { data: { fields?: { name: string; value: string }[] } }[];
    };
    expect(privatePayload.embeds[0]?.data.fields).toEqual([
      { name: 'XENON ID', value: 'XN-1042', inline: true },
      { name: 'WHITELIST', value: 'APPROVED', inline: true },
    ]);
  });

  it('does not grant a citizen role that has acquired Discord permissions', async () => {
    mocks.settings.mockResolvedValue([
      row('discord.welcome.enabled', true),
      row('discord.welcome.initialRoleKey', 'role.citizen'),
    ]);
    mocks.managedRole.mockResolvedValue({ discordResourceId: 'citizen-role', managed: true });
    const view = makeMember();
    vi.mocked(view.member.guild.roles.fetch).mockResolvedValue({
      id: 'citizen-role',
      managed: false,
      permissions: { bitfield: 1n },
    } as never);

    await handleMemberJoin(view.member);

    expect(view.roleAdd).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      { guildId: 'guild-id' },
      'Skipped unsafe or unavailable Xenon initial role',
    );
  });
});
