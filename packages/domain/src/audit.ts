import type { AuditLog, Db, Prisma } from '@xenon/database';
import type { Actor } from '@xenon/permissions';

/**
 * The audit log.
 *
 * Append-only by convention and by the absence of any update path here. Every
 * consequential mutation writes one row, and the row is written inside the same
 * transaction as the change it describes - so a decision without an audit entry
 * is impossible rather than merely unlikely.
 *
 * The actor's display label is denormalised alongside the id: deleting an
 * account nulls `actorId`, and a log that then reads "someone approved this" is
 * useless exactly when it matters.
 */

export interface AuditInput {
  /** Dotted verb, e.g. `application.approved`, `whitelist.revoked`. */
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  /** Public identifier, so the log is searchable by what staff actually quote. */
  readonly entityLabel?: string | null;
  readonly before?: Prisma.InputJsonValue | null;
  readonly after?: Prisma.InputJsonValue | null;
  readonly metadata?: Prisma.InputJsonValue | null;
}

/**
 * Keys scrubbed from any before/after projection.
 *
 * Services are expected to pass safe projections, but the audit log is the last
 * place a token should ever appear, so the guard is here rather than trusted to
 * every call site.
 */
const FORBIDDEN_KEYS = new Set([
  'access_token',
  'refresh_token',
  'id_token',
  'sessionToken',
  'codeHash',
  'secret',
  'password',
  'token',
]);

function scrub(value: Prisma.InputJsonValue | null | undefined): Prisma.InputJsonValue | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const items = value as readonly (Prisma.InputJsonValue | null)[];
    return items.map((entry) => scrub(entry) ?? null);
  }

  const output: Record<string, Prisma.InputJsonValue> = {};
  const entries = Object.entries(value as Record<string, Prisma.InputJsonValue | undefined>);

  for (const [key, entry] of entries) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    const cleaned = scrub(entry);
    if (cleaned !== undefined) output[key] = cleaned;
  }
  return output;
}

/** Write one audit row. Pass the transaction handle when inside a transaction. */
export async function recordAudit(db: Db, actor: Actor, input: AuditInput): Promise<AuditLog> {
  const before = scrub(input.before);
  const after = scrub(input.after);
  const metadata = scrub(input.metadata);

  return db.auditLog.create({
    data: {
      action: input.action,
      actorId: actor.userId,
      actorLabel: actor.label,
      source: actor.source,
      entityType: input.entityType,
      entityId: input.entityId,
      entityLabel: input.entityLabel ?? null,
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
      ...(metadata === undefined ? {} : { metadata }),
      ipHash: actor.ipHash ?? null,
      userAgent: actor.userAgent ?? null,
    },
  });
}

export interface AuditQuery {
  readonly action?: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly actorId?: string;
  readonly search?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly skip?: number;
  readonly take?: number;
}

export interface AuditPage {
  readonly items: readonly (AuditLog & { actor: { publicId: string } | null })[];
  readonly total: number;
}

/** Read the audit log. Callers must already have checked `audit.view`. */
export async function queryAudit(db: Db, query: AuditQuery = {}): Promise<AuditPage> {
  const take = Math.min(query.take ?? 50, 200);

  const where: Prisma.AuditLogWhereInput = {
    ...(query.action === undefined ? {} : { action: { startsWith: query.action } }),
    ...(query.entityType === undefined ? {} : { entityType: query.entityType }),
    ...(query.entityId === undefined ? {} : { entityId: query.entityId }),
    ...(query.actorId === undefined ? {} : { actorId: query.actorId }),
    ...(query.from === undefined && query.to === undefined
      ? {}
      : {
          createdAt: {
            ...(query.from === undefined ? {} : { gte: query.from }),
            ...(query.to === undefined ? {} : { lte: query.to }),
          },
        }),
    ...(query.search === undefined || query.search.length === 0
      ? {}
      : {
          OR: [
            { entityLabel: { contains: query.search, mode: 'insensitive' } },
            { actorLabel: { contains: query.search, mode: 'insensitive' } },
            { action: { contains: query.search, mode: 'insensitive' } },
          ],
        }),
  };

  const [items, total] = await Promise.all([
    db.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: query.skip ?? 0,
      take,
      include: { actor: { select: { publicId: true } } },
    }),
    db.auditLog.count({ where }),
  ]);

  return { items, total };
}

/** The history of one entity, oldest first. Powers the timeline panels. */
export async function entityHistory(
  db: Db,
  entityType: string,
  entityId: string,
): Promise<readonly AuditLog[]> {
  return db.auditLog.findMany({
    where: { entityType, entityId },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });
}
