import { NotFoundError } from '@xenon/core';
import type { Db, Department } from '@xenon/database';
import { cacheDelete, cached } from '@xenon/jobs';
import { type Actor, requirePermission } from '@xenon/permissions';
import type { DepartmentInput } from '@xenon/validation';

import { recordAudit } from './audit';

/**
 * Departments.
 *
 * Data-driven end to end: adding the Department of Justice is a row and some
 * copy, never a new React route. The public page, the detail page, the
 * application mapping and the Discord role mapping all read from here.
 */

const LIST_CACHE_KEY = 'departments:published';
const LIST_CACHE_TTL = 300;

export interface PublicDepartment {
  readonly slug: string;
  readonly name: string;
  readonly shortName: string | null;
  readonly tagline: string | null;
  readonly description: string | null;
  readonly heroImageUrl: string | null;
  readonly logoUrl: string | null;
  readonly accentColour: string | null;
  readonly recruitmentState: Department['recruitmentState'];
  readonly requirements: readonly string[];
}

/** Published departments, ordered, cached. Drives the public index. */
export async function publishedDepartments(db: Db): Promise<readonly PublicDepartment[]> {
  return cached(LIST_CACHE_KEY, LIST_CACHE_TTL, async () => {
    const rows = await db.department.findMany({
      where: { status: 'PUBLISHED' },
      orderBy: { sortOrder: 'asc' },
    });

    return rows.map((row): PublicDepartment => ({
      slug: row.slug,
      name: row.name,
      shortName: row.shortName,
      tagline: row.tagline,
      description: row.description,
      heroImageUrl: row.heroImageUrl,
      logoUrl: row.logoUrl,
      accentColour: row.accentColour,
      recruitmentState: row.recruitmentState,
      requirements: row.requirements,
    }));
  });
}

/**
 * One department with everything the detail page renders.
 *
 * Leadership is filtered to current members only: a roster that still lists
 * someone who left last season is worse than no roster.
 */
export async function departmentBySlug(db: Db, slug: string) {
  return db.department.findFirst({
    where: { slug, status: 'PUBLISHED' },
    include: {
      members: {
        where: { leftAt: null, isLeadership: true },
        orderBy: { sortOrder: 'asc' },
        include: {
          user: {
            select: {
              publicId: true,
              displayName: true,
              avatarUrl: true,
              discordAccount: { select: { username: true } },
            },
          },
        },
      },
      templates: {
        where: { status: 'OPEN' },
        select: { slug: true, name: true, summary: true },
      },
      gallery: {
        where: { status: 'PUBLISHED' },
        orderBy: { sortOrder: 'asc' },
        take: 12,
      },
    },
  });
}

export async function upsertDepartment(
  db: Db,
  actor: Actor,
  input: DepartmentInput,
  departmentId?: string,
): Promise<Department> {
  requirePermission(actor, 'departments.manage');

  const data = {
    slug: input.slug,
    name: input.name,
    shortName: input.shortName ?? null,
    tagline: input.tagline ?? null,
    description: input.description ?? null,
    body: input.body ?? null,
    heroImageUrl: input.heroImageUrl ?? null,
    logoUrl: input.logoUrl ?? null,
    accentColour: input.accentColour ?? null,
    recruitmentState: input.recruitmentState,
    requirements: input.requirements,
    roleKey: input.roleKey ?? null,
    status: input.status,
    sortOrder: input.sortOrder,
    ...(input.status === 'PUBLISHED' ? { publishedAt: new Date() } : {}),
  };

  const department =
    departmentId === undefined
      ? await db.department.create({ data })
      : await db.department.update({ where: { id: departmentId }, data });

  await recordAudit(db, actor, {
    action: departmentId === undefined ? 'department.created' : 'department.updated',
    entityType: 'department',
    entityId: department.id,
    entityLabel: department.slug,
    after: { name: department.name, status: department.status },
  });

  await cacheDelete(LIST_CACHE_KEY);
  return department;
}

export async function deleteDepartment(db: Db, actor: Actor, departmentId: string): Promise<void> {
  requirePermission(actor, 'departments.manage');

  const department = await db.department.findUnique({ where: { id: departmentId } });
  if (department === null) throw new NotFoundError('Department', departmentId);

  await db.department.delete({ where: { id: departmentId } });
  await recordAudit(db, actor, {
    action: 'department.deleted',
    entityType: 'department',
    entityId: departmentId,
    entityLabel: department.slug,
    before: { name: department.name },
  });
  await cacheDelete(LIST_CACHE_KEY);
}

/** Add or update a roster entry. */
export async function setDepartmentMember(
  db: Db,
  actor: Actor,
  input: {
    departmentId: string;
    userId: string;
    rank?: string | null;
    isLeadership?: boolean;
    sortOrder?: number;
  },
): Promise<void> {
  requirePermission(actor, 'departments.manage');

  await db.departmentMember.upsert({
    where: {
      departmentId_userId: { departmentId: input.departmentId, userId: input.userId },
    },
    create: {
      departmentId: input.departmentId,
      userId: input.userId,
      rank: input.rank ?? null,
      isLeadership: input.isLeadership ?? false,
      sortOrder: input.sortOrder ?? 0,
    },
    update: {
      rank: input.rank ?? null,
      isLeadership: input.isLeadership ?? false,
      sortOrder: input.sortOrder ?? 0,
      // Re-adding someone who previously left clears the departure rather than
      // creating a second row.
      leftAt: null,
    },
  });

  await recordAudit(db, actor, {
    action: 'department.member_set',
    entityType: 'department',
    entityId: input.departmentId,
    after: { userId: input.userId, rank: input.rank ?? null },
  });
  await cacheDelete(LIST_CACHE_KEY);
}

/** Mark a member as departed. The row stays, so the history stays. */
export async function removeDepartmentMember(
  db: Db,
  actor: Actor,
  departmentId: string,
  userId: string,
): Promise<void> {
  requirePermission(actor, 'departments.manage');

  await db.departmentMember.updateMany({
    where: { departmentId, userId, leftAt: null },
    data: { leftAt: new Date() },
  });

  await recordAudit(db, actor, {
    action: 'department.member_removed',
    entityType: 'department',
    entityId: departmentId,
    before: { userId },
  });
  await cacheDelete(LIST_CACHE_KEY);
}

/** Every department including drafts, with roster counts. Staff view. */
export async function listDepartmentsForStaff(db: Db) {
  return db.department.findMany({
    orderBy: { sortOrder: 'asc' },
    include: {
      _count: { select: { members: true, templates: true } },
    },
  });
}
