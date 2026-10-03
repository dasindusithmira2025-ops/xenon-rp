import { describe, expect, it, vi } from 'vitest';

import type { Db } from '@xenon/database';

import { syncGuildMembership } from './membership';

function fakeDb() {
  const updateMany = vi.fn((_args: { where: unknown; data: Record<string, unknown> }) =>
    Promise.resolve({ count: 1 }),
  );
  const db = { discordAccount: { updateMany } } as unknown as Db;
  return { db, updateMany };
}

describe('syncGuildMembership', () => {
  it('persists a confirmed member snapshot', async () => {
    const { db, updateMany } = fakeDb();
    const joinedAt = new Date('2026-09-01T00:00:00Z');

    const state = await syncGuildMembership(
      db,
      {
        member: () =>
          Promise.resolve({
            nickname: 'City Player',
            joinedAt,
            roleIds: ['role-1'],
            pendingScreening: false,
          }),
      },
      'test-discord-member',
    );

    expect(state).toBe('MEMBER');
    expect(updateMany.mock.calls[0]?.[0].data).toMatchObject({
      isGuildMember: true,
      guildMembershipState: 'MEMBER',
      guildNickname: 'City Player',
      guildJoinedAt: joinedAt,
      guildRoleIds: ['role-1'],
      guildSyncError: null,
    });
  });

  it('records screening-pending separately and does not treat it as verified membership', async () => {
    const { db, updateMany } = fakeDb();

    const state = await syncGuildMembership(
      db,
      {
        member: () =>
          Promise.resolve({
            nickname: null,
            joinedAt: null,
            roleIds: [],
            pendingScreening: true,
          }),
      },
      'test-discord-screening',
    );

    expect(state).toBe('PENDING_SCREENING');
    expect(updateMany.mock.calls[0]?.[0].data).toMatchObject({
      isGuildMember: false,
      guildMembershipState: 'PENDING_SCREENING',
    });
  });

  it('records a confirmed non-member without confusing it with an API outage', async () => {
    const { db, updateMany } = fakeDb();

    const state = await syncGuildMembership(
      db,
      { member: () => Promise.resolve(null) },
      'test-discord-non-member',
    );

    expect(state).toBe('NOT_MEMBER');
    expect(updateMany.mock.calls[0]?.[0].data).toMatchObject({
      isGuildMember: false,
      guildMembershipState: 'NOT_MEMBER',
      guildRoleIds: [],
    });
  });

  it('stores unavailable and rethrows transient lookup failure for bounded retries', async () => {
    const { db, updateMany } = fakeDb();
    const failure = new Error('Discord unavailable');

    await expect(
      syncGuildMembership(
        db,
        { member: () => Promise.reject(failure) },
        'test-discord-unavailable',
      ),
    ).rejects.toBe(failure);

    expect(updateMany.mock.calls[0]?.[0].data).toMatchObject({
      isGuildMember: false,
      guildMembershipState: 'UNAVAILABLE',
      guildSyncError: 'Discord could not confirm this membership right now',
    });
  });
});
