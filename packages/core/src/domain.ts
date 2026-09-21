/**
 * Domain unions that the whole platform shares.
 *
 * These are declared here rather than imported from the generated Prisma client
 * so that pure domain packages carry no database edge. `@xenon/database` asserts
 * at compile time that each one still matches its Prisma enum, so the two can
 * never drift apart silently.
 */

/** Which interface an action arrived through. Recorded on every audit entry. */
export const actionSources = ['WEB', 'DISCORD', 'SYSTEM', 'FIVEM'] as const;
export type ActionSource = (typeof actionSources)[number];
