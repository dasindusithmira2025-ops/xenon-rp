import { DiscordAPIError } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findNotification: vi.fn(),
  recordDelivery: vi.fn(),
  fetchUser: vi.fn(),
  sendDm: vi.fn(),
  isReady: vi.fn(),
  hasCredentials: vi.fn(),
  findArticle: vi.fn(),
  updateArticle: vi.fn(),
  findMessageReference: vi.fn(),
  createMessageReference: vi.fn(),
  channelFetch: vi.fn(),
  sendAnnouncement: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@xenon/applications', () => ({ expireStaleSubmissions: vi.fn() }));
vi.mock('@xenon/core', () => ({
  IntegrationError: class IntegrationError extends Error {
    constructor(
      _service: string,
      message: string,
      _options: { retryable: boolean; cause?: unknown },
    ) {
      super(message);
    }
  },
}));
vi.mock('@xenon/database', () => ({
  prisma: {
    notification: { findUnique: mocks.findNotification },
    article: { findUnique: mocks.findArticle, update: mocks.updateArticle },
    discordMessageReference: {
      findFirst: mocks.findMessageReference,
      create: mocks.createMessageReference,
    },
    $transaction: (operations: Promise<unknown>[]) => Promise.all(operations),
  },
}));
vi.mock('@xenon/discord', () => ({
  buildNotificationEmbed: vi.fn(() => ({})),
  loadSupportSettings: vi
    .fn()
    .mockResolvedValue({ dmNotifications: true, allowDiscordClose: true }),
  XenonAnnouncementPanel: vi.fn(() => ({ title: 'XENON ANNOUNCEMENT' })),
  XenonTicketPanel: vi.fn(() => ({ embeds: [], components: [] })),
  xenonIds: { ticketClose: vi.fn(() => 'xn:ticket:close:XN-TK-1') },
  syncGuildMembership: vi.fn(),
  syncUserRoles: vi.fn(),
  updateGuildMembership: vi.fn(),
}));
vi.mock('@xenon/domain', () => ({
  expireRoleAssignments: vi.fn(),
  liftExpiredSuspensions: vi.fn(),
  pruneStatusSnapshots: vi.fn(),
  recordStatusSnapshot: vi.fn(),
}));
vi.mock('@xenon/fivem', () => ({
  pollServerStatus: vi.fn(),
  pruneLinkTokens: vi.fn(),
  syncWhitelistForUser: vi.fn(),
}));
vi.mock('@xenon/notifications', () => ({ recordDiscordDelivery: mocks.recordDelivery }));
vi.mock('@xenon/permissions', () => ({ systemActor: {} }));
vi.mock('../discord/client', () => ({
  discordClient: () => ({
    users: { fetch: mocks.fetchUser },
    channels: { fetch: mocks.channelFetch },
  }),
  isDiscordReady: mocks.isReady,
  primaryGuild: vi.fn(),
}));
vi.mock('../discord/provisioning/context', () => ({ linksAllowed: () => true }));
vi.mock('../discord/membership-port', () => ({ guildMembershipPort: vi.fn() }));
vi.mock('../discord/review-card', () => ({ postOrUpdateReviewCard: vi.fn() }));
vi.mock('../discord/role-port', () => ({ guildRolePort: vi.fn() }));
vi.mock('../runtime', () => ({
  botEnv: { NEXT_PUBLIC_SITE_URL: 'https://xenon.example.test' },
  hasRealDiscordCredentials: mocks.hasCredentials,
  logger: mocks.logger,
}));

import { prisma } from '@xenon/database';

import { handlers } from './handlers';

const notification = {
  id: 'notification-1',
  discordState: 'PENDING',
  title: 'Application update',
  body: 'Your application changed.',
  href: '/portal/applications/XN-WL-1',
  type: 'APPLICATION_APPROVED',
  user: { discordAccount: { discordId: '12345678901234567' } },
};

function closedDmError(): DiscordAPIError {
  return Object.assign(Object.create(DiscordAPIError.prototype) as DiscordAPIError, {
    code: 50007,
  });
}

describe('Discord notification delivery failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findNotification.mockResolvedValue(notification);
    mocks.recordDelivery.mockResolvedValue(undefined);
    mocks.fetchUser.mockResolvedValue({ send: mocks.sendDm });
    mocks.sendDm.mockResolvedValue(undefined);
    mocks.isReady.mockReturnValue(true);
    mocks.hasCredentials.mockReturnValue(true);
    mocks.findArticle.mockResolvedValue(null);
    mocks.updateArticle.mockResolvedValue(undefined);
    mocks.findMessageReference.mockResolvedValue(null);
    mocks.createMessageReference.mockResolvedValue(undefined);
    mocks.channelFetch.mockResolvedValue({
      isTextBased: () => true,
      send: mocks.sendAnnouncement,
      messages: { fetch: vi.fn() },
    });
    mocks.sendAnnouncement.mockResolvedValue({ id: 'announcement-message' });
  });

  it('records that DMs are unavailable when a player has closed them', async () => {
    mocks.sendDm.mockRejectedValue(closedDmError());

    await handlers['discord.dm']({ notificationId: notification.id });

    expect(mocks.recordDelivery).toHaveBeenCalledWith(prisma, notification.id, {
      delivered: false,
      error: 'This player has direct messages closed',
    });
  });

  it('records disabled integration as a skip without attempting a Discord request', async () => {
    mocks.hasCredentials.mockReturnValue(false);

    await handlers['discord.dm']({ notificationId: notification.id });

    expect(mocks.recordDelivery).toHaveBeenCalledWith(prisma, notification.id, {
      delivered: false,
      error: 'Discord is not configured in this environment',
    });
    expect(mocks.fetchUser).not.toHaveBeenCalled();
  });

  it('lets a transient REST rate limit reach the bounded job retry policy', async () => {
    const rateLimit = Object.assign(new Error('rate limited'), { status: 429 });
    mocks.sendDm.mockRejectedValue(rateLimit);

    await expect(handlers['discord.dm']({ notificationId: notification.id })).rejects.toBe(
      rateLimit,
    );
    expect(mocks.recordDelivery).not.toHaveBeenCalled();
  });
});

describe('Discord announcement delivery', () => {
  it('posts one text-first announcement and records the message for retry safety', async () => {
    const article = {
      id: 'article-1',
      slug: 'city-update',
      title: 'City update',
      excerpt: 'The new update is live.',
      status: 'PUBLISHED',
      announcementType: 'UPDATE',
      publishToWebsite: true,
      discordChannelId: 'channel-id',
      discordNotifyRoleId: 'role-id',
      announcedAt: null,
      scheduledAt: null,
    };
    mocks.findArticle.mockResolvedValue(article);

    await handlers['discord.channel.post']({
      channelId: 'channel-id',
      kind: 'ANNOUNCEMENT',
      entityType: 'announcement',
      entityId: 'article-1',
    });

    expect(mocks.sendAnnouncement).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '<@&role-id>',
        embeds: [{ title: 'XENON ANNOUNCEMENT' }],
        allowedMentions: { parse: [], roles: ['role-id'] },
      }),
    );
    const messageReferenceCall = mocks.createMessageReference.mock.calls[0]?.[0] as unknown as {
      data: Record<string, unknown>;
    };
    expect(messageReferenceCall.data).toMatchObject({
      kind: 'ANNOUNCEMENT',
      channelId: 'channel-id',
      messageId: 'announcement-message',
      entityId: 'article-1',
    });
    const updateCall = mocks.updateArticle.mock.calls[0]?.[0] as unknown as {
      where: { id: string };
      data: { announcedAt: unknown };
    };
    expect(updateCall.where.id).toBe('article-1');
    expect(updateCall.data.announcedAt).toBeInstanceOf(Date);
  });
});
