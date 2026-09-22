import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  resolveActor: vi.fn(),
  anonymousActor: vi.fn(() => ({ userId: null, source: 'DISCORD' })),
}));

vi.mock('@xenon/database', () => ({
  prisma: { discordAccount: { findUnique: mocks.findUnique } },
}));
vi.mock('@xenon/permissions', () => ({
  anonymousActor: mocks.anonymousActor,
  resolveActor: mocks.resolveActor,
}));

import { actorFromDiscord } from './actor';

describe('Discord reviewer identity resolution', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps a Discord snowflake through its linked Xenon user before resolving capabilities', async () => {
    const actor = { userId: 'xenon-staff-user', source: 'DISCORD' };
    mocks.findUnique.mockResolvedValue({ userId: 'xenon-staff-user' });
    mocks.resolveActor.mockResolvedValue(actor);

    await expect(actorFromDiscord('discord-staff-snowflake')).resolves.toBe(actor);
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { discordId: 'discord-staff-snowflake' },
      select: { userId: true },
    });
    expect(mocks.resolveActor).toHaveBeenCalledWith(expect.anything(), {
      userId: 'xenon-staff-user',
      source: 'DISCORD',
    });
  });

  it('gives an unlinked Discord user no Xenon capabilities', async () => {
    mocks.findUnique.mockResolvedValue(null);

    await expect(actorFromDiscord('unlinked-snowflake')).resolves.toEqual({
      userId: null,
      source: 'DISCORD',
    });
    expect(mocks.resolveActor).not.toHaveBeenCalled();
  });
});
