import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueueBestEffort: vi.fn(),
  cacheDelete: vi.fn(),
  recordAudit: vi.fn(),
  requirePermission: vi.fn(),
}));

vi.mock('@xenon/jobs', () => ({
  cacheDelete: mocks.cacheDelete,
  cached: vi.fn(),
  enqueueBestEffort: mocks.enqueueBestEffort,
}));
vi.mock('@xenon/permissions', () => ({
  requirePermission: mocks.requirePermission,
  systemActor: { userId: 'system', source: 'SYSTEM' },
}));
vi.mock('./audit', () => ({ recordAudit: mocks.recordAudit }));

import { createAnnouncement } from './content';

describe('canonical announcement publishing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueueBestEffort.mockResolvedValue(undefined);
  });

  it('validates a managed Discord destination, records the announcement, and queues delivery', async () => {
    const article = {
      id: 'article-id',
      slug: 'city-update-abc123',
      title: 'A city update is live',
      excerpt: 'The latest update is now available.',
      body: '<p>The latest update is now available.</p>',
      status: 'DRAFT',
      publishedAt: null,
      announcementType: 'UPDATE',
      publishToWebsite: false,
      publishToDiscord: true,
      discordChannelId: '123456789012345678',
      discordNotifyRoleId: null,
      scheduledAt: null,
    };
    const db = {
      discordGuild: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'guild-row',
          guildId: 'guild-id',
          announcementChannelId: null,
        }),
      },
      discordManagedResource: {
        findFirst: vi.fn().mockResolvedValue({ logicalKey: 'channel.announcements' }),
      },
      article: { create: vi.fn().mockResolvedValue(article) },
    };
    const actor = { userId: 'staff-user', source: 'WEB' };

    const result = await createAnnouncement(db as never, actor as never, {
      title: 'A city update is live',
      body: 'The latest update is now available.',
      type: 'UPDATE',
      toWebsite: false,
      toDiscord: true,
      discordChannelId: '123456789012345678',
    });

    expect(result).toEqual(article);
    const createCall = db.article.create.mock.calls[0]?.[0] as unknown as {
      data: Record<string, unknown>;
    };
    expect(createCall.data).toMatchObject({
      status: 'DRAFT',
      publishToWebsite: false,
      publishToDiscord: true,
      discordChannelId: '123456789012345678',
    });
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      db,
      actor,
      expect.objectContaining({ action: 'ANNOUNCEMENT_PUBLISHED' }),
    );
    expect(mocks.enqueueBestEffort).toHaveBeenCalledWith('discord.channel.post', {
      channelId: '123456789012345678',
      kind: 'ANNOUNCEMENT',
      entityType: 'announcement',
      entityId: 'article-id',
    });
  });
});
