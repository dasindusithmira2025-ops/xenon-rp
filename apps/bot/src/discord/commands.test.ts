import { PermissionFlagsBits } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  announcementChannel: vi.fn(),
  announcementPanel: vi.fn(() => ({ toJSON: () => ({ title: 'XENON ANNOUNCEMENT' }) })),
}));

vi.mock('@xenon/applications', () => ({
  approveApplication: vi.fn(),
  getOwnApplication: vi.fn(),
  listReviewQueue: vi.fn(),
  rejectApplication: vi.fn(),
  requestChanges: vi.fn(),
  statusLabels: {},
}));
vi.mock('@xenon/config', () => ({ brand: {} }));
vi.mock('@xenon/core', () => ({ toSafeMessage: () => 'Request failed.' }));
vi.mock('@xenon/database', () => ({
  prisma: { discordGuild: { findUnique: mocks.announcementChannel } },
}));
vi.mock('@xenon/discord', () => ({
  buildStatusEmbed: vi.fn(),
  XenonAnnouncementPanel: mocks.announcementPanel,
}));
vi.mock('@xenon/domain', () => ({ findUserByReference: vi.fn(), statusBoard: vi.fn() }));
vi.mock('@xenon/fivem', () => ({ redeemLinkCode: vi.fn() }));
vi.mock('@xenon/permissions', () => ({ can: vi.fn() }));
vi.mock('@xenon/validation', () => ({ linkCodeInput: { safeParse: vi.fn() } }));
vi.mock('../runtime', () => ({ botEnv: {}, logger: { error: vi.fn() } }));
vi.mock('./actor', () => ({ actorFromDiscord: vi.fn() }));
vi.mock('./setup-command', () => ({ handleXenonCommand: vi.fn(), xenonCommand: {} }));
vi.mock('./temp-voice', () => ({ handleRoomCommand: vi.fn(), roomCommand: {} }));

import { commandDefinitions, handleAnnouncementCommand } from './commands';

describe('database-configured announcement readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('posts to the adopted integration channel without a provisioning run', async () => {
    mocks.announcementChannel.mockResolvedValue({ announcementChannelId: 'adopted-channel' });
    const send = vi.fn().mockResolvedValue(undefined);
    const channel = {
      isTextBased: () => true,
      permissionsFor: () => ({ has: () => true }),
      send,
    };
    const fetchChannel = vi.fn().mockResolvedValue(channel);
    const interaction = {
      guild: {
        ownerId: 'someone-else',
        channels: { fetch: fetchChannel },
        members: { fetchMe: vi.fn().mockResolvedValue({ id: 'bot' }) },
      },
      guildId: 'guild-id',
      user: { id: 'operator' },
      memberPermissions: {
        has: (permission: bigint) => permission === PermissionFlagsBits.ManageGuild,
      },
      options: {
        getString: (key: string) => (key === 'title' ? 'Maintenance' : 'The city is restarting.'),
      },
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleAnnouncementCommand(interaction as never);

    expect(fetchChannel).toHaveBeenCalledWith('adopted-channel');
    expect(send).toHaveBeenCalledWith({
      embeds: [{ title: 'XENON ANNOUNCEMENT' }],
      allowedMentions: { parse: [] },
    });
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Announcement posted.' }),
    );
    expect(commandDefinitions.map((command) => command.name)).toContain('announce');
  });
});
