import type { ActionSource as DomainActionSource } from '@xenon/core';

import type { ActionSource as PrismaActionSource } from '../generated/client/client';

/**
 * Compile-time parity between the hand-written domain unions in `@xenon/core`
 * and the enums Prisma generates from the schema.
 *
 * Core declares these unions itself so that pure domain packages carry no
 * database dependency. The cost of that is two places to keep in step, so this
 * module makes the drift a type error at build time rather than a runtime
 * surprise the first time an unfamiliar value reaches the database.
 *
 * Adding a value to the Prisma enum without adding it to core - or the reverse -
 * fails `pnpm typecheck` here. The file exports nothing and exists only for its
 * type assertions.
 */

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

function assertExact<A, B>(_proof: Exact<A, B>): void {
  // Intentionally empty: the proof is discharged by the type checker.
}

assertExact<DomainActionSource, PrismaActionSource>(true);

export {};
