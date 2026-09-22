import 'server-only';

import { headers } from 'next/headers';
import { forbidden, unauthorized } from 'next/navigation';
import { cache } from 'react';

import { actorFromSession, auth } from '@xenon/auth';
import type { PermissionKey } from '@xenon/core';
import { type Actor, requirePermission } from '@xenon/permissions';

/**
 * Request context.
 *
 * Every server component, server action and route handler gets its actor from
 * here. Nothing else in the app reads the session, so the mapping from "a
 * cookie exists" to "these are the capabilities" happens in exactly one place
 * and cannot be skipped by a new page that forgets to check.
 *
 * `cache()` dedupes within a single render pass: a page that checks the actor
 * in the layout, the header and three components resolves once.
 */

/** Best guess at the client address, for rate-limit buckets and hashed audit. */
async function clientAddress(): Promise<string | null> {
  const store = await headers();

  // Behind a proxy the first entry of X-Forwarded-For is the client. This is
  // only ever used hashed, for abuse buckets and audit correlation, so a
  // spoofed value costs the spoofer their own bucket rather than anyone else's.
  const forwarded = store.get('x-forwarded-for');
  if (forwarded !== null) {
    const first = forwarded.split(',')[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
  }

  return store.get('x-real-ip');
}

export const currentActor = cache(async (): Promise<Actor> => {
  const [session, store, ip] = await Promise.all([auth(), headers(), clientAddress()]);

  return actorFromSession(session, {
    ip,
    userAgent: store.get('user-agent'),
    source: 'WEB',
  });
});

/**
 * The actor, or an HTTP 401 page.
 *
 * `unauthorized()` renders the app's `unauthorized.tsx` boundary rather than
 * redirecting, which keeps the URL intact so the sign-in can return the player
 * to the page they actually wanted.
 */
export async function requireSignedIn(): Promise<Actor> {
  const actor = await currentActor();
  if (actor.userId === null) unauthorized();
  return actor;
}

/**
 * The actor, or an HTTP 403 page, having checked they hold *some* staff
 * capability.
 *
 * For control-centre screens that are not gated on one particular capability -
 * the health page is the only one - so that authorization does not rest on the
 * layout alone. A layout does not re-run on every client-side navigation
 * within its segment, which makes "the layout checks it" a weaker guarantee
 * than it reads as.
 */
export async function requireStaff(): Promise<Actor> {
  const actor = await currentActor();
  if (actor.userId === null) unauthorized();

  if (actor.permissions.size === 0) forbidden();
  return actor;
}

/** The actor, or an HTTP 403 page, having checked one capability. */
export async function requireCapability(permission: PermissionKey): Promise<Actor> {
  const actor = await currentActor();
  if (actor.userId === null) unauthorized();

  if (!actor.permissions.has(permission)) forbidden();
  return actor;
}

/** The user id of the signed-in actor. Convenience for owner-scoped queries. */
export async function requireUserId(): Promise<string> {
  const actor = await requireSignedIn();
  // `requireSignedIn` has already proved this, but the types do not know it.
  return actor.userId ?? '';
}

/**
 * Assert a capability inside a server action.
 *
 * Differs from `requireCapability` in what it does on failure: an action throws
 * a `ForbiddenError` that the action wrapper turns into a form-level message,
 * whereas a page navigates to an error boundary.
 */
export async function assertCapability(permission: PermissionKey): Promise<Actor> {
  const actor = await currentActor();
  requirePermission(actor, permission);
  return actor;
}

/** Rate-limit identity: the account when signed in, the hashed address when not. */
export function rateLimitIdentity(actor: Actor): string {
  if (actor.userId !== null) return actor.userId;
  return actor.ipHash ?? 'anonymous';
}
