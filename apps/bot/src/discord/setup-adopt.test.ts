import { ChannelType } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {},
  blueprintFeatures: vi.fn(),
  loadDepartmentInputs: vi.fn(),
  loadOrganizationSpaces: vi.fn(),
  buildDesiredState: vi.fn(),
  adoptExistingResources: vi.fn(),
}));

vi.mock('@xenon/database', () => ({ prisma: mocks.prisma }));
vi.mock('@xenon/discord/provisioning', () => ({
  blueprintFeatures: mocks.blueprintFeatures,
  loadDepartmentInputs: mocks.loadDepartmentInputs,
  loadOrganizationSpaces: mocks.loadOrganizationSpaces,
  buildDesiredState: mocks.buildDesiredState,
  adoptExistingResources: mocks.adoptExistingResources,
}));

import { adoptGuildResources } from './setup-adopt';

describe('setup adoption Discord API boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.blueprintFeatures.mockResolvedValue({});
    mocks.loadDepartmentInputs.mockResolvedValue([]);
    mocks.loadOrganizationSpaces.mockResolvedValue([]);
    mocks.buildDesiredState.mockReturnValue({ roles: [], channels: [] });
    mocks.adoptExistingResources.mockResolvedValue({
      adopted: [],
      alreadyMapped: [],
      missing: [],
      ambiguous: [],
    });
  });

  it('reads only live channels and roles and never calls AutoMod or mutation APIs', async () => {
    const channel = {
      id: 'existing-welcome',
      name: 'welcome',
      type: ChannelType.GuildText,
      isThread: vi.fn(() => false),
      create: vi.fn(),
      edit: vi.fn(),
      delete: vi.fn(),
    };
    const role = { id: 'existing-moderator', name: 'Moderator', managed: false };
    const channelsFetch = vi.fn().mockResolvedValue(new Map([[channel.id, channel]]));
    const rolesFetch = vi.fn().mockResolvedValue(new Map([[role.id, role]]));
    const automodFetch = vi.fn();
    const guild = {
      id: 'guild-id',
      name: 'Existing server',
      features: ['COMMUNITY'],
      channels: { fetch: channelsFetch },
      roles: { fetch: rolesFetch },
      autoModerationRules: { fetch: automodFetch, create: vi.fn() },
      emojis: { create: vi.fn() },
      stickers: { create: vi.fn() },
    };
    const actor = { permissions: new Set(['system.discord.bootstrap']) };

    await adoptGuildResources(guild as never, actor as never);

    expect(channelsFetch).toHaveBeenCalledOnce();
    expect(rolesFetch).toHaveBeenCalledOnce();
    expect(automodFetch).not.toHaveBeenCalled();
    expect(channel.create).not.toHaveBeenCalled();
    expect(channel.edit).not.toHaveBeenCalled();
    expect(channel.delete).not.toHaveBeenCalled();
    expect(mocks.adoptExistingResources).toHaveBeenCalledWith(
      mocks.prisma,
      actor,
      expect.objectContaining({
        guildId: 'guild-id',
        channels: [{ id: channel.id, name: channel.name, kind: 'text' }],
        roles: [{ id: role.id, name: role.name, managed: false }],
      }),
    );
  });
});
