import { ConflictError, NotFoundError, normalisePublicId } from '@xenon/core';
import {
  allocatePublicId,
  type Db,
  type Prisma,
  type Ticket,
  type TicketStatus,
  transaction,
} from '@xenon/database';
import { enforceRateLimit } from '@xenon/jobs';
import { createNotification, dispatchPending, notificationCopy } from '@xenon/notifications';
import {
  type Actor,
  can,
  requireOwnerOrPermission,
  requirePermission,
  requireUser,
} from '@xenon/permissions';
import type { TicketInput, TicketReplyInput } from '@xenon/validation';

import { recordAudit } from './audit';
import { hashIp } from './hashing';

/**
 * Support tickets.
 *
 * Content lives in Postgres. Discord may be told that a ticket exists, but a
 * thread in a channel is not storage: threads are archived, channels are
 * deleted, and a player asking "what did staff tell me in March" needs an
 * answer that does not depend on Discord's retention.
 */

export async function createTicket(
  db: Db,
  actor: Actor,
  input: TicketInput,
  context: { ip?: string | null } = {},
): Promise<Ticket> {
  const userId = requireUser(actor);
  await enforceRateLimit('ticketCreate', userId);

  const publicId = await allocatePublicId(db, 'ticket');

  const ticket = await transaction(db, async (tx) => {
    const created = await tx.ticket.create({
      data: {
        publicId,
        authorId: userId,
        category: input.category,
        subject: input.subject,
        status: 'OPEN',
        createdIpHash: hashIp(context.ip),
      },
    });

    await tx.ticketMessage.create({
      data: {
        ticketId: created.id,
        authorId: userId,
        body: input.body,
        visibility: 'APPLICANT',
        mediaIds: input.mediaIds,
        source: actor.source,
      },
    });

    return created;
  });

  await recordAudit(db, actor, {
    action: 'ticket.created',
    entityType: 'ticket',
    entityId: ticket.id,
    entityLabel: ticket.publicId,
    after: { category: ticket.category, subject: ticket.subject },
  });

  return ticket;
}

/**
 * Post a reply.
 *
 * The status flips to reflect who owes the next move, which is what keeps the
 * staff queue meaningful without anyone maintaining it by hand.
 */
export async function replyToTicket(
  db: Db,
  actor: Actor,
  input: TicketReplyInput,
): Promise<Ticket> {
  const userId = requireUser(actor);

  const ticket = await db.ticket.findUnique({ where: { id: input.ticketId } });
  if (ticket === null) throw new NotFoundError('Ticket', input.ticketId);
  if (ticket.status === 'CLOSED') {
    throw new ConflictError('Ticket is closed', 'This ticket is closed. Open a new one.');
  }

  const isStaff = can(actor, 'tickets.reply');
  requireOwnerOrPermission(actor, ticket.authorId, 'tickets.reply');

  // Only staff may write an internal note; a player-authored "internal" comment
  // would be visible to staff and invisible to the person who wrote it.
  const visibility = isStaff ? input.visibility : 'APPLICANT';

  await enforceRateLimit('ticketReply', userId);

  const now = new Date();
  const nextStatus: TicketStatus = isStaff ? 'WAITING_FOR_PLAYER' : 'WAITING_FOR_STAFF';

  const updated = await transaction(db, async (tx) => {
    await tx.ticketMessage.create({
      data: {
        ticketId: ticket.id,
        authorId: userId,
        body: input.body,
        visibility,
        mediaIds: input.mediaIds,
        source: actor.source,
      },
    });

    return tx.ticket.update({
      where: { id: ticket.id },
      data: {
        lastMessageAt: now,
        // An internal note is staff talking to staff; it does not change whose
        // turn it is.
        ...(visibility === 'INTERNAL' ? {} : { status: nextStatus }),
      },
    });
  });

  if (isStaff && visibility === 'APPLICANT') {
    const copy = notificationCopy.ticketReply(ticket.publicId, ticket.subject);
    const notification = await createNotification(db, { userId: ticket.authorId, ...copy });
    await dispatchPending([notification]);
  }

  return updated;
}

export async function updateTicket(
  db: Db,
  actor: Actor,
  input: {
    ticketId: string;
    status: TicketStatus;
    priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT' | undefined;
    assigneeId?: string | null | undefined;
  },
): Promise<Ticket> {
  requirePermission(actor, 'tickets.manage');

  const before = await db.ticket.findUnique({ where: { id: input.ticketId } });
  if (before === null) throw new NotFoundError('Ticket', input.ticketId);

  const now = new Date();
  const ticket = await db.ticket.update({
    where: { id: input.ticketId },
    data: {
      status: input.status,
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.assigneeId === undefined ? {} : { assigneeId: input.assigneeId }),
      ...(input.status === 'RESOLVED' ? { resolvedAt: now } : {}),
      ...(input.status === 'CLOSED' ? { closedAt: now } : {}),
    },
  });

  await recordAudit(db, actor, {
    action: 'ticket.updated',
    entityType: 'ticket',
    entityId: ticket.id,
    entityLabel: ticket.publicId,
    before: { status: before.status, assigneeId: before.assigneeId },
    after: { status: ticket.status, assigneeId: ticket.assigneeId },
  });

  if (input.status === 'RESOLVED' && before.status !== 'RESOLVED') {
    const copy = notificationCopy.ticketResolved(ticket.publicId);
    const notification = await createNotification(db, { userId: ticket.authorId, ...copy });
    await dispatchPending([notification]);
  }

  return ticket;
}

/**
 * Load a ticket with its thread.
 *
 * Internal notes are filtered out at the query, not in the view: a component
 * that forgets to filter is a leak, a query that never returns them is not.
 */
export async function getTicket(db: Db, actor: Actor, publicIdOrId: string) {
  const normalised = normalisePublicId(publicIdOrId, 'TK');
  const ticket = await db.ticket.findFirst({
    where: normalised === null ? { id: publicIdOrId } : { publicId: normalised },
    select: { id: true, authorId: true },
  });
  if (ticket === null) throw new NotFoundError('Ticket', publicIdOrId);

  requireOwnerOrPermission(actor, ticket.authorId, 'tickets.view');
  const isStaff = can(actor, 'tickets.view');

  return db.ticket.findUnique({
    where: { id: ticket.id },
    include: {
      author: { select: { publicId: true, displayName: true, avatarUrl: true } },
      assignee: { select: { publicId: true, displayName: true } },
      messages: {
        where: {
          deletedAt: null,
          ...(isStaff ? {} : { visibility: 'APPLICANT' }),
        },
        orderBy: { createdAt: 'asc' },
        include: {
          author: { select: { publicId: true, displayName: true, avatarUrl: true } },
        },
      },
    },
  });
}

export interface TicketQuery {
  readonly status?: TicketStatus;
  readonly category?: Prisma.TicketWhereInput['category'];
  readonly assigneeId?: string | null;
  readonly authorId?: string;
  readonly search?: string;
  readonly skip?: number;
  readonly take?: number;
}

/** The staff queue, or a player's own tickets when `authorId` is set. */
export async function listTickets(db: Db, query: TicketQuery = {}) {
  const take = Math.min(query.take ?? 25, 100);

  const where: Prisma.TicketWhereInput = {
    ...(query.status === undefined ? {} : { status: query.status }),
    ...(query.category === undefined ? {} : { category: query.category }),
    ...(query.assigneeId === undefined ? {} : { assigneeId: query.assigneeId }),
    ...(query.authorId === undefined ? {} : { authorId: query.authorId }),
    ...(query.search === undefined || query.search.length === 0
      ? {}
      : {
          OR: [
            { publicId: { contains: query.search.toUpperCase() } },
            { subject: { contains: query.search, mode: 'insensitive' } },
          ],
        }),
  };

  const [items, total] = await Promise.all([
    db.ticket.findMany({
      where,
      orderBy: { lastMessageAt: 'desc' },
      skip: query.skip ?? 0,
      take,
      include: {
        author: { select: { publicId: true, displayName: true, avatarUrl: true } },
        assignee: { select: { publicId: true, displayName: true } },
        _count: { select: { messages: true } },
      },
    }),
    db.ticket.count({ where }),
  ]);

  return { items, total };
}

/** Counts for the staff overview tiles. */
export async function ticketCounts(db: Db): Promise<Record<TicketStatus, number>> {
  const grouped = await db.ticket.groupBy({ by: ['status'], _count: { _all: true } });

  const counts: Record<TicketStatus, number> = {
    OPEN: 0,
    WAITING_FOR_STAFF: 0,
    WAITING_FOR_PLAYER: 0,
    RESOLVED: 0,
    CLOSED: 0,
  };
  for (const row of grouped) counts[row.status] = row._count._all;
  return counts;
}
