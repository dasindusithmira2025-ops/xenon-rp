import { NotFoundError, normalisePublicId } from '@xenon/core';
import {
  allocatePublicId,
  type Db,
  type Prisma,
  type Report,
  type ReportKind,
  type ReportStatus,
} from '@xenon/database';
import { enforceRateLimit } from '@xenon/jobs';
import { createNotification, dispatchPending, notificationCopy } from '@xenon/notifications';
import {
  type Actor,
  requireAnyPermission,
  requirePermission,
  requireUser,
} from '@xenon/permissions';
import type { ReportInput } from '@xenon/validation';

import { recordAudit } from './audit';
import { hashIp } from './hashing';

/**
 * Reports.
 *
 * Kept apart from tickets because they carry accusations. In particular, a
 * report filed *against a staff member* must not be readable by every staff
 * member - including the subject - so it sits behind its own capability pair
 * rather than behind `reports.view`.
 */

/** The capability needed to see a report of this kind. */
function viewPermission(kind: ReportKind): 'reports.view' | 'reports.staff.view' {
  return kind === 'STAFF' ? 'reports.staff.view' : 'reports.view';
}

function managePermission(kind: ReportKind): 'reports.manage' | 'reports.staff.manage' {
  return kind === 'STAFF' ? 'reports.staff.manage' : 'reports.manage';
}

export async function createReport(
  db: Db,
  actor: Actor,
  input: ReportInput,
  context: { ip?: string | null } = {},
): Promise<Report> {
  const userId = requireUser(actor);
  await enforceRateLimit('reportCreate', userId);

  const publicId = await allocatePublicId(db, 'report');

  // The accused is resolved to an account where possible so the staff view can
  // link to their history; an unmatched name is kept as free text rather than
  // rejected, because players do not always know the XN id.
  let subjectId: string | null = null;
  if (input.subjectPublicId !== undefined) {
    const normalised = normalisePublicId(input.subjectPublicId, null);
    if (normalised !== null) {
      const subject = await db.user.findUnique({
        where: { publicId: normalised },
        select: { id: true },
      });
      subjectId = subject?.id ?? null;
    }
  }

  const report = await db.report.create({
    data: {
      publicId,
      kind: input.kind,
      reporterId: userId,
      subjectId,
      subjectLabel: input.subjectLabel ?? input.subjectPublicId ?? null,
      summary: input.summary,
      details: input.details,
      occurredAt: input.occurredAt ?? null,
      mediaIds: input.mediaIds,
      createdIpHash: hashIp(context.ip),
    },
  });

  await recordAudit(db, actor, {
    action: 'report.created',
    entityType: 'report',
    entityId: report.id,
    entityLabel: report.publicId,
    after: { kind: report.kind, summary: report.summary },
  });

  return report;
}

export async function updateReport(
  db: Db,
  actor: Actor,
  input: {
    reportId: string;
    status: ReportStatus;
    priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT' | undefined;
    assigneeId?: string | null | undefined;
    outcome?: string | undefined;
  },
): Promise<Report> {
  const before = await db.report.findUnique({ where: { id: input.reportId } });
  if (before === null) throw new NotFoundError('Report', input.reportId);

  requirePermission(actor, managePermission(before.kind));

  const terminal = input.status === 'ACTIONED' || input.status === 'DISMISSED';

  const report = await db.report.update({
    where: { id: input.reportId },
    data: {
      status: input.status,
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.assigneeId === undefined ? {} : { assigneeId: input.assigneeId }),
      ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
      ...(terminal ? { resolvedAt: new Date() } : {}),
    },
  });

  await recordAudit(db, actor, {
    action: 'report.updated',
    entityType: 'report',
    entityId: report.id,
    entityLabel: report.publicId,
    before: { status: before.status, assigneeId: before.assigneeId },
    after: { status: report.status, assigneeId: report.assigneeId },
  });

  // The reporter is told the state changed, never what action was taken against
  // another player - that is between staff and the subject.
  if (report.reporterId !== null && before.status !== report.status) {
    const copy = notificationCopy.reportUpdate(report.publicId, report.status);
    const notification = await createNotification(db, { userId: report.reporterId, ...copy });
    await dispatchPending([notification]);
  }

  return report;
}

export async function getReport(db: Db, actor: Actor, publicIdOrId: string) {
  const normalised = normalisePublicId(publicIdOrId, 'RP');
  const report = await db.report.findFirst({
    where: normalised === null ? { id: publicIdOrId } : { publicId: normalised },
  });
  if (report === null) throw new NotFoundError('Report', publicIdOrId);

  // The reporter can always follow their own report; everyone else needs the
  // capability for that report's kind.
  if (report.reporterId === null || report.reporterId !== actor.userId) {
    requirePermission(actor, viewPermission(report.kind));
  }

  return db.report.findUnique({
    where: { id: report.id },
    include: {
      reporter: { select: { publicId: true, displayName: true } },
      subject: { select: { publicId: true, displayName: true, whitelistState: true } },
      assignee: { select: { publicId: true, displayName: true } },
    },
  });
}

export interface ReportQuery {
  readonly kind?: ReportKind;
  readonly status?: ReportStatus;
  readonly assigneeId?: string | null;
  readonly search?: string;
  readonly skip?: number;
  readonly take?: number;
}

/**
 * The staff report queue.
 *
 * Staff reports are excluded unless the actor holds `reports.staff.view`, and
 * that filter is applied to the query rather than to the rendered list.
 */
export async function listReports(db: Db, actor: Actor, query: ReportQuery = {}) {
  requireAnyPermission(actor, ['reports.view', 'reports.staff.view']);

  const canSeeStaffReports = actor.permissions.has('reports.staff.view');
  const canSeeOthers = actor.permissions.has('reports.view');

  const kindFilter: Prisma.ReportWhereInput =
    query.kind !== undefined
      ? { kind: query.kind }
      : canSeeStaffReports && canSeeOthers
        ? {}
        : canSeeStaffReports
          ? { kind: 'STAFF' }
          : { kind: { in: ['PLAYER', 'BUG'] } };

  if (query.kind === 'STAFF' && !canSeeStaffReports) {
    requirePermission(actor, 'reports.staff.view');
  }

  const take = Math.min(query.take ?? 25, 100);
  const where: Prisma.ReportWhereInput = {
    ...kindFilter,
    ...(query.status === undefined ? {} : { status: query.status }),
    ...(query.assigneeId === undefined ? {} : { assigneeId: query.assigneeId }),
    ...(query.search === undefined || query.search.length === 0
      ? {}
      : {
          OR: [
            { publicId: { contains: query.search.toUpperCase() } },
            { summary: { contains: query.search, mode: 'insensitive' } },
            { subjectLabel: { contains: query.search, mode: 'insensitive' } },
          ],
        }),
  };

  const [items, total] = await Promise.all([
    db.report.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      skip: query.skip ?? 0,
      take,
      include: {
        reporter: { select: { publicId: true, displayName: true } },
        subject: { select: { publicId: true, displayName: true } },
        assignee: { select: { publicId: true, displayName: true } },
      },
    }),
    db.report.count({ where }),
  ]);

  return { items, total };
}

/** Reports a player filed themselves, for the portal. */
export async function listOwnReports(db: Db, userId: string) {
  return db.report.findMany({
    where: { reporterId: userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
}
