import {
  type ActionSource,
  ForbiddenError,
  type PermissionKey,
  UnauthenticatedError,
} from '@xenon/core';
import { prisma } from '@xenon/database';
import { hashIp } from '@xenon/domain';
import { type Actor, anonymousActor, requirePermission, resolveActor } from '@xenon/permissions';

/**
 * Session to `Actor`.
 *
 * The bridge between "there is a cookie" and "these are the capabilities". It
 * is the only place the two meet, so there is exactly one implementation of
 * role expiry, account suspension and request context - and a server action
 * that forgets to check something cannot exist, because it never sees a session
 * at all, only an `Actor`.
 *
 * `auth()` is passed in rather than imported to keep this module free of the
 * Next.js request context, which is what lets it be unit-tested.
 */

export interface RequestContext {
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly source?: ActionSource;
}

type SessionLike = { user?: { id?: string | null } | null } | null;

/**
 * Resolve the current actor, or the anonymous actor when signed out.
 *
 * Never throws for an anonymous caller: plenty of the site is public, and the
 * decision to require a session belongs to the operation, not to the lookup.
 */
export async function actorFromSession(
  session: SessionLike,
  context: RequestContext = {},
): Promise<Actor> {
  const source = context.source ?? 'WEB';
  const userId = session?.user?.id;

  if (userId === undefined || userId === null || userId === '') {
    return anonymousActor(source);
  }

  const actor = await resolveActor(prisma, {
    userId,
    source,
    ipHash: hashIp(context.ip) ?? undefined,
    userAgent: context.userAgent?.slice(0, 300) ?? undefined,
  });

  // A session pointing at a deleted account resolves to anonymous rather than
  // to a broken half-actor. The stale cookie then simply prompts a sign-in.
  return actor ?? anonymousActor(source);
}

/** Resolve an actor and require that there is a signed-in user behind it. */
export async function requireActor(
  session: SessionLike,
  context: RequestContext = {},
): Promise<Actor> {
  const actor = await actorFromSession(session, context);
  if (actor.userId === null) throw new UnauthenticatedError();
  return actor;
}

/** Resolve an actor and require one capability. Used by staff screens. */
export async function requireCapability(
  session: SessionLike,
  permission: PermissionKey,
  context: RequestContext = {},
): Promise<Actor> {
  const actor = await requireActor(session, context);
  requirePermission(actor, permission);
  return actor;
}

/**
 * True when the actor holds any staff capability at all.
 *
 * Used only to decide whether to show the link to /control in the navigation.
 * Authorization for anything inside it is per-capability and server-side; this
 * is presentation.
 */
export function isStaff(actor: Actor): boolean {
  return actor.permissions.size > 0;
}

/** Narrow a thrown authorization failure for a transport layer. */
export function isAuthorizationError(error: unknown): boolean {
  return error instanceof UnauthenticatedError || error instanceof ForbiddenError;
}
