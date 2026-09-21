import { type ActionSource, isPermissionKey, type PermissionKey } from '@xenon/core';
import type { Db } from '@xenon/database';

import { type Actor } from './actor';

export interface ResolveActorInput {
  readonly userId: string;
  readonly source: ActionSource;
  readonly ipHash?: string | undefined;
  readonly userAgent?: string | undefined;
}

/**
 * Build an `Actor` from the database.
 *
 * This is the only path from "a session exists" to "these are the capabilities",
 * so there is one place where role expiry, account suspension and unknown
 * capability strings are handled.
 *
 * Returns null when the user does not exist, so callers can distinguish a
 * missing account from an account with no permissions.
 */
export async function resolveActor(db: Db, input: ResolveActorInput): Promise<Actor | null> {
  const user = await db.user.findUnique({
    where: { id: input.userId },
    select: {
      id: true,
      publicId: true,
      displayName: true,
      status: true,
      deletedAt: true,
      discordAccount: { select: { username: true, globalName: true } },
      roles: {
        select: {
          expiresAt: true,
          role: {
            select: {
              key: true,
              permissions: { select: { permission: { select: { key: true } } } },
            },
          },
        },
      },
    },
  });

  if (user === null) return null;
  // A soft-deleted account resolves to nothing rather than to an actor with no
  // permissions, so callers can tell "gone" from "present but powerless".
  if (user.deletedAt !== null) return null;

  const now = new Date();
  const permissions = new Set<PermissionKey>();
  const roleKeys = new Set<string>();

  // A suspended or banned account keeps its role rows - the sanction is meant
  // to be reversible - but exercises none of them until it is reinstated.
  const sanctioned = user.status !== 'ACTIVE';

  for (const assignment of user.roles) {
    if (assignment.expiresAt !== null && assignment.expiresAt <= now) continue;

    roleKeys.add(assignment.role.key);
    if (sanctioned) continue;

    for (const { permission } of assignment.role.permissions) {
      // A capability removed from the catalogue can still have a stale row in
      // the database. Ignoring it is safer than trusting a key the code no
      // longer understands.
      if (isPermissionKey(permission.key)) {
        permissions.add(permission.key);
      }
    }
  }

  return {
    userId: user.id,
    publicId: user.publicId,
    label:
      user.displayName ??
      user.discordAccount?.globalName ??
      user.discordAccount?.username ??
      user.publicId,
    source: input.source,
    permissions,
    roleKeys,
    ipHash: input.ipHash,
    userAgent: input.userAgent,
  };
}

/**
 * An actor for a request with no session.
 *
 * Distinct from `systemActor`: this one fails `requirePermission` with an
 * "unauthenticated" error rather than a "forbidden" one, which is the
 * difference between prompting a sign-in and showing an access-denied page.
 */
export function anonymousActor(source: ActionSource = 'WEB'): Actor {
  return {
    userId: null,
    publicId: null,
    label: 'Anonymous',
    source,
    permissions: new Set<PermissionKey>(),
    roleKeys: new Set<string>(),
  };
}
