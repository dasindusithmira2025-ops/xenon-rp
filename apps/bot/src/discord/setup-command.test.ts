import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  actorFromDiscord: vi.fn(),
  adoptGuildResources: vi.fn(),
  adoptionReply: vi.fn(),
  logger: { warn: vi.fn() },
  createRun: vi.fn(),
  executeProvisionRun: vi.fn(),
}));

vi.mock('@xenon/core', () => ({ toSafeMessage: () => 'Request failed.' }));
vi.mock('@xenon/database', () => ({ prisma: {} }));
vi.mock('@xenon/discord', () => ({ xenonEmbed: vi.fn(), xenonIds: {} }));
vi.mock('@xenon/discord/provisioning', () => ({
  createRun: mocks.createRun,
  panelHash: vi.fn(),
  planItems: vi.fn(() => []),
  planProfile: vi.fn(),
  PROVISION_PHRASE: 'PROVISION XENON',
  saveBlueprintFeatures: vi.fn(),
  blueprintFeatures: vi.fn(),
}));
vi.mock('@xenon/domain', () => ({ recordAudit: vi.fn() }));
vi.mock('../runtime', () => ({ logger: mocks.logger }));
vi.mock('./actor', () => ({ actorFromDiscord: mocks.actorFromDiscord }));
vi.mock('./provisioning/context', () => ({ loadProvisioningContext: vi.fn() }));
vi.mock('./provisioning/report', () => ({ buildRunEmbed: vi.fn(), controlUrl: vi.fn() }));
vi.mock('./provisioning/runner', () => ({ executeProvisionRun: mocks.executeProvisionRun }));
vi.mock('./setup-adopt', () => ({
  adoptionReply: mocks.adoptionReply,
  adoptGuildResources: mocks.adoptGuildResources,
}));

import { handleXenonCommand, xenonCommand } from './setup-command';

function interaction(overrides: Record<string, unknown> = {}) {
  const events: string[] = [];
  const result = {
    options: {
      getSubcommandGroup: vi.fn(() => 'setup'),
      getSubcommand: vi.fn(() => 'adopt'),
    },
    deferReply: vi.fn(() => {
      events.push('defer');
      return Promise.resolve();
    }),
    editReply: vi.fn(() => Promise.resolve()),
    reply: vi.fn(() => Promise.resolve()),
    guildId: 'guild-id',
    guild: { ownerId: 'owner-id', id: 'guild-id', name: 'Existing server' },
    user: { id: 'member-id', username: 'member' },
    ...overrides,
  };
  return { value: result, events };
}

describe('/xenon setup adopt command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.actorFromDiscord.mockResolvedValue({ permissions: new Set() });
    mocks.adoptGuildResources.mockResolvedValue({ plan: {}, state: {} });
    mocks.adoptionReply.mockReturnValue('XENON EXISTING SERVER ADOPTED');
  });

  it('defers immediately, then responds with the adoption summary', async () => {
    const view = interaction({
      guild: { ownerId: 'member-id', id: 'guild-id', name: 'Existing server' },
    });
    mocks.actorFromDiscord.mockImplementation(() => {
      expect(view.events).toEqual(['defer']);
      return Promise.resolve({ permissions: new Set() });
    });

    await handleXenonCommand(view.value as never);

    expect(view.value.deferReply).toHaveBeenCalledOnce();
    expect(mocks.adoptGuildResources).toHaveBeenCalledOnce();
    expect(view.value.editReply).toHaveBeenCalledWith('XENON EXISTING SERVER ADOPTED');
    expect(mocks.createRun).not.toHaveBeenCalled();
    expect(mocks.executeProvisionRun).not.toHaveBeenCalled();
  });

  it('keeps setup administration permission protected', async () => {
    const view = interaction();

    await handleXenonCommand(view.value as never);

    expect(view.value.deferReply).toHaveBeenCalledOnce();
    expect(view.value.editReply).toHaveBeenCalledWith(
      expect.stringContaining('system.discord.bootstrap'),
    );
    expect(mocks.adoptGuildResources).not.toHaveBeenCalled();
    const definition = xenonCommand as unknown as {
      readonly default_member_permissions?: string;
      readonly options?: readonly {
        readonly name: string;
        readonly options?: readonly { readonly name: string }[];
      }[];
    };
    const setup = definition.options?.find((option) => option.name === 'setup');
    expect(setup?.options?.some((option) => option.name === 'adopt')).toBe(true);
    expect(definition.default_member_permissions).toBeDefined();
  });
});
