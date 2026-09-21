import {
  type ActionSource,
  ForbiddenError,
  type PermissionKey,
  UnauthenticatedError,
} from '@xenon/core';

/**
 * Who is performing an operation, and with what authority.
 *
 * Every domain service takes an `Actor` rather than reading a session itself.
 * That is what lets the identical `approveApplication()` run from a web form,
 * from a Discord button and from a scheduled job, with the authorization check
 * written exactly once.
 *
 * Capabilities are resolved up-front from the database, never from Discord role
 * membership observed at call time.
 */
export interface Actor {
  /** Null only for SYSTEM actors. */
  readonly userId: string | null;
  /** Public identifier, e.g. XN-10082. Null for SYSTEM actors. */
  readonly publicId: string | null;
  /**
   * Display label preserved in the audit log, so the log stays readable after
   * the account is deleted and `userId` becomes null.
   */
  readonly label: string;
  /** Which interface the action arrived through. */
  readonly source: ActionSource;
  readonly permissions: ReadonlySet<PermissionKey>;
  readonly roleKeys: ReadonlySet<string>;
  /** Hashed, never raw: the audit log is not an address book. */
  readonly ipHash?: string | undefined;
  readonly userAgent?: string | undefined;
}

/**
 * The platform acting on its own behalf: expiry sweeps, retries, sync jobs.
 *
 * Holds no capabilities. System operations call service functions that do not
 * require one, so a bug in a worker cannot quietly escalate into an approval.
 */
export const systemActor: Actor = {
  userId: null,
  publicId: null,
  label: 'System',
  source: 'SYSTEM',
  permissions: new Set<PermissionKey>(),
  roleKeys: new Set<string>(),
};

/** True when the actor holds the capability. */
export function can(actor: Actor, permission: PermissionKey): boolean {
  return actor.permissions.has(permission);
}

/** True when the actor holds every listed capability. */
export function canAll(actor: Actor, permissions: readonly PermissionKey[]): boolean {
  return permissions.every((permission) => actor.permissions.has(permission));
}

/** True when the actor holds at least one of the listed capabilities. */
export function canAny(actor: Actor, permissions: readonly PermissionKey[]): boolean {
  return permissions.some((permission) => actor.permissions.has(permission));
}

/**
 * Assert a capability, throwing if it is missing.
 *
 * Throwing rather than returning a boolean is deliberate: a forgotten `if` is
 * invisible, a forgotten `await require...` is not, and the failure mode of
 * this function is a refused request rather than a silent authorization bypass.
 */
export function requirePermission(actor: Actor, permission: PermissionKey): void {
  if (actor.userId === null && actor.source !== 'SYSTEM') {
    throw new UnauthenticatedError();
  }
  if (!actor.permissions.has(permission)) {
    throw new ForbiddenError(permission, actor.userId);
  }
}

/** Assert every listed capability. Reports the first one that is missing. */
export function requireAllPermissions(actor: Actor, permissions: readonly PermissionKey[]): void {
  for (const permission of permissions) {
    requirePermission(actor, permission);
  }
}

/** Assert at least one of the listed capabilities. */
export function requireAnyPermission(actor: Actor, permissions: readonly PermissionKey[]): void {
  if (canAny(actor, permissions)) return;

  if (actor.userId === null && actor.source !== 'SYSTEM') {
    throw new UnauthenticatedError();
  }
  throw new ForbiddenError(permissions.join(' or '), actor.userId);
}

/** Assert that there is a signed-in user at all, without requiring a capability. */
export function requireUser(actor: Actor): string {
  if (actor.userId === null) {
    throw new UnauthenticatedError();
  }
  return actor.userId;
}

/**
 * Allow an action when the actor owns the record, or otherwise holds the
 * capability that would let staff act on anyone's record.
 *
 * The common shape for "view my own ticket" versus "view any ticket", written
 * once so each call site cannot get the precedence subtly wrong.
 */
export function requireOwnerOrPermission(
  actor: Actor,
  ownerId: string,
  permission: PermissionKey,
): void {
  if (actor.userId !== null && actor.userId === ownerId) return;
  requirePermission(actor, permission);
}
