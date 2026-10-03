import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  allocatePublicId: vi.fn(),
  enforceRateLimit: vi.fn(),
  enqueueBestEffort: vi.fn(),
  recordAudit: vi.fn(),
  hashIp: vi.fn(),
}));

vi.mock('@xenon/database', () => ({
  allocatePublicId: mocks.allocatePublicId,
  transaction: (_db: unknown, callback: (tx: unknown) => Promise<unknown>) => callback(_db),
}));
vi.mock('@xenon/jobs', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
  enqueueBestEffort: mocks.enqueueBestEffort,
}));
vi.mock('@xenon/notifications', () => ({
  createNotification: vi.fn(),
  dispatchPending: vi.fn(),
  notificationCopy: {},
}));
vi.mock('@xenon/permissions', () => ({
  can: vi.fn(() => false),
  requireOwnerOrPermission: vi.fn(),
  requirePermission: vi.fn(),
  requireUser: (actor: { userId?: string }) => actor.userId ?? 'user-id',
}));
vi.mock('./audit', () => ({ recordAudit: mocks.recordAudit }));
vi.mock('./hashing', () => ({ hashIp: mocks.hashIp }));

import { createTicket } from './tickets';

describe('canonical ticket creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.allocatePublicId.mockResolvedValue('XN-TK-1042');
    mocks.enforceRateLimit.mockResolvedValue(undefined);
    mocks.enqueueBestEffort.mockResolvedValue(undefined);
    mocks.hashIp.mockReturnValue('ip-hash');
  });

  it('stores ticket content in Xenon and queues only a Discord notification', async () => {
    const created = {
      id: 'ticket-row-id',
      publicId: 'XN-TK-1042',
      category: 'TECHNICAL',
      subject: 'FiveM will not connect',
      status: 'OPEN',
    };
    const db = {
      ticket: { create: vi.fn().mockResolvedValue(created) },
      ticketMessage: { create: vi.fn().mockResolvedValue({ id: 'message-row-id' }) },
    };
    const actor = { userId: 'xenon-user-id', source: 'WEB' };

    const result = await createTicket(
      db as never,
      actor as never,
      {
        category: 'TECHNICAL',
        subject: 'FiveM will not connect',
        body: 'The client cannot reach the city after the update.',
        mediaIds: [],
      },
      { ip: '192.0.2.1' },
    );

    expect(result).toEqual(created);
    const ticketCreateCall = db.ticket.create.mock.calls[0]?.[0] as unknown as {
      data: Record<string, unknown>;
    };
    expect(ticketCreateCall.data).toMatchObject({
      publicId: 'XN-TK-1042',
      authorId: 'xenon-user-id',
      category: 'TECHNICAL',
      status: 'OPEN',
      createdIpHash: 'ip-hash',
    });
    const messageCreateCall = db.ticketMessage.create.mock.calls[0]?.[0] as unknown as {
      data: Record<string, unknown>;
    };
    expect(messageCreateCall.data).toMatchObject({
      ticketId: 'ticket-row-id',
      authorId: 'xenon-user-id',
      visibility: 'APPLICANT',
      source: 'WEB',
    });
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      db,
      actor,
      expect.objectContaining({ action: 'SUPPORT_TICKET_CREATED' }),
    );
    expect(mocks.enqueueBestEffort).toHaveBeenCalledWith('discord.ticket.created', {
      ticketId: 'ticket-row-id',
    });
  });
});
