import {
  ConflictError,
  formatPublicId,
  type PublicIdKind,
  publicIdKinds,
  SEGMENT_PATTERN,
} from '@xenon/core';

import type { Db } from './client';

/**
 * Allocate the next public identifier for an entity family.
 *
 * Lives here rather than in `@xenon/core` because it is the only part of the
 * public-id story that touches the database, and keeping core free of any
 * database edge is what keeps the package graph acyclic. The formatting and
 * parsing rules stay in core, where they can be unit-tested without Postgres.
 *
 * `nextval` is transactional but is never rolled back, so a failed transaction
 * burns a number rather than handing the same one to two rows. Gaps are the
 * intended trade: uniqueness matters, contiguity does not.
 *
 * Pass `segmentOverride` for applications, where the segment comes from the
 * template (`WL`, `PD`, `EMS`) rather than from the entity family.
 */
export async function allocatePublicId(
  db: Db,
  kind: PublicIdKind,
  segmentOverride?: string,
): Promise<string> {
  const spec = publicIdKinds[kind];
  const segment = segmentOverride ?? spec.segment;

  if (segment !== null && !SEGMENT_PATTERN.test(segment)) {
    throw new RangeError(`Invalid public id segment: ${segment}`);
  }

  // The sequence name comes from the frozen `publicIdKinds` table in core and
  // never from caller input, so interpolating it is safe. Prisma cannot
  // parameterise an SQL identifier.
  const rows = await db.$queryRawUnsafe<{ nextval: bigint }[]>(
    `SELECT nextval('${spec.sequence}') AS nextval`,
  );

  const next = rows[0]?.nextval;
  if (next === undefined) {
    throw new ConflictError(
      `Sequence ${spec.sequence} returned no value`,
      'Could not allocate an identifier. Please try again.',
    );
  }

  return formatPublicId(Number(next), segment, spec.pad);
}
