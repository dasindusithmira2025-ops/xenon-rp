import { MessageFlags, type ButtonInteraction } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resource: vi.fn(),
  consumeRateLimit: vi.fn(),
  recordAudit: vi.fn(),
  actorFromDiscord: vi.fn(),
  logger: { warn: vi.fn() },
}));

vi.mock('@xenon/database', () => ({
  prisma: { discordManagedResource: { findUnique: mocks.resource } },
}));
vi.mock('@xenon/domain', () => ({ recordAudit: mocks.recordAudit }));
vi.mock('@xenon/jobs', () => ({
  consumeRateLimit: mocks.consumeRateLimit,
  rateLimits: { discordSelfRole: 'self-role-limit' },
}));
vi.mock('../runtime', () => ({ logger: mocks.logger }));
vi.mock('./actor', () => ({ actorFromDiscord: mocks.actorFromDiscord }));

import { handleRoleToggle } from './self-roles';

function makeInteraction({
  key = 'role.notify.events',
  rolePermissions = 0n,
  managed = false,
  alreadyHasRole = false,
}: {
  key?: string;
  rolePermissions?: bigint;
  managed?: boolean;
  alreadyHasRole?: boolean;
} = {}) {
  const reply = vi.fn();
  const role = {
    id: 'role-id',
    name: 'Events',
    permissions: { bitfield: rolePermissions },
    managed,
  };
  const roleAdd = vi.fn();
  const roleRemove = vi.fn();
  const interaction = {
    customId: `xn:role:toggle:${key}`,
    user: { id: 'discord-user' },
    guild: {
      id: 'guild-id',
      roles: { fetch: vi.fn().mockResolvedValue(role) },
      members: {
        fetch: vi.fn().mockResolvedValue({
          roles: {
            cache: { has: () => alreadyHasRole },
            add: roleAdd,
            remove: roleRemove,
          },
        }),
      },
    },
    reply,
  } as unknown as ButtonInteraction;
  return { interaction, reply, role, roleAdd, roleRemove };
}

function xenonId(key: string): Parameters<typeof handleRoleToggle>[1] {
  return { namespace: 'role', action: 'toggle', argument: key };
}

describe('self-role safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.consumeRateLimit.mockResolvedValue({ allowed: true });
    mocks.resource.mockResolvedValue({ discordResourceId: 'role-id', managed: true });
    mocks.actorFromDiscord.mockResolvedValue({ userId: 'xenon-user', source: 'DISCORD' });
  });

  it('rejects staff and department role keys before resolving a Discord role', async () => {
    const view = makeInteraction({ key: 'role.staff' });

    await handleRoleToggle(view.interaction, xenonId('role.staff'));

    expect(view.reply).toHaveBeenCalledWith({
      content: 'That button is no longer available.',
      flags: MessageFlags.Ephemeral,
    });
    expect(mocks.resource).not.toHaveBeenCalled();
  });

  it('refuses a configured notification role if it gains permissions', async () => {
    const view = makeInteraction({ rolePermissions: 8n });

    await handleRoleToggle(view.interaction, xenonId('role.notify.events'));

    expect(view.reply).toHaveBeenCalledWith({
      content: 'That role is not available right now.',
      flags: MessageFlags.Ephemeral,
    });
    expect(mocks.actorFromDiscord).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it('adds a safe notification role and audits the assigned state', async () => {
    const view = makeInteraction();

    await handleRoleToggle(view.interaction, xenonId('role.notify.events'));

    expect(view.roleAdd).toHaveBeenCalledWith(view.role, 'Self-role via #choose-roles');
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: 'SELF_ROLE_ADDED', entityId: 'role.notify.events' }),
    );
  });
});
