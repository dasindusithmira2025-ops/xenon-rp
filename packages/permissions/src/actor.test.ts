import { describe, expect, it } from 'vitest';

import { ForbiddenError, type PermissionKey, UnauthenticatedError } from '@xenon/core';

import {
  type Actor,
  can,
  canAll,
  canAny,
  requireAnyPermission,
  requireOwnerOrPermission,
  requirePermission,
  requireUser,
  systemActor,
} from './actor';

function actorWith(permissions: readonly PermissionKey[], userId: string | null = 'user_1'): Actor {
  return {
    userId,
    publicId: userId === null ? null : 'XN-10082',
    label: 'Test Actor',
    source: 'WEB',
    permissions: new Set(permissions),
    roleKeys: new Set<string>(),
  };
}

describe('capability checks', () => {
  const actor = actorWith(['applications.view', 'applications.review']);

  it('reports held and missing capabilities', () => {
    expect(can(actor, 'applications.view')).toBe(true);
    expect(can(actor, 'applications.approve')).toBe(false);
  });

  it('distinguishes all from any', () => {
    expect(canAll(actor, ['applications.view', 'applications.review'])).toBe(true);
    expect(canAll(actor, ['applications.view', 'applications.approve'])).toBe(false);
    expect(canAny(actor, ['applications.approve', 'applications.review'])).toBe(true);
    expect(canAny(actor, ['applications.approve', 'players.ban'])).toBe(false);
  });
});

describe('requirePermission', () => {
  it('passes when the capability is held', () => {
    expect(() => {
      requirePermission(actorWith(['applications.approve']), 'applications.approve');
    }).not.toThrow();
  });

  it('throws Forbidden for a signed-in actor without the capability', () => {
    expect(() => {
      requirePermission(actorWith([]), 'applications.approve');
    }).toThrow(ForbiddenError);
  });

  it('throws Unauthenticated rather than Forbidden when there is no session', () => {
    // The distinction drives the response: prompt a sign-in, or show access
    // denied. Collapsing them would send signed-out users to a dead end.
    expect(() => {
      requirePermission(actorWith([], null), 'applications.approve');
    }).toThrow(UnauthenticatedError);
  });

  it('names the missing capability on the error', () => {
    try {
      requirePermission(actorWith([]), 'players.ban');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as ForbiddenError).required).toBe('players.ban');
      // The message shown to a user must not leak the capability string.
      expect((error as ForbiddenError).safeMessage).not.toContain('players.ban');
    }
  });
});

describe('requireAnyPermission', () => {
  it('passes when one of the alternatives is held', () => {
    expect(() => {
      requireAnyPermission(actorWith(['reports.view']), ['reports.view', 'reports.staff.view']);
    }).not.toThrow();
  });

  it('throws when none are held', () => {
    expect(() => {
      requireAnyPermission(actorWith([]), ['reports.view', 'reports.staff.view']);
    }).toThrow(ForbiddenError);
  });
});

describe('requireOwnerOrPermission', () => {
  it('lets an owner act on their own record without any capability', () => {
    expect(() => {
      requireOwnerOrPermission(actorWith([], 'user_1'), 'user_1', 'tickets.view');
    }).not.toThrow();
  });

  it('requires the capability for someone else record', () => {
    expect(() => {
      requireOwnerOrPermission(actorWith([], 'user_1'), 'user_2', 'tickets.view');
    }).toThrow(ForbiddenError);
  });

  it('does not treat an anonymous actor as the owner of a null-owned record', () => {
    // Guards against `actor.userId === ownerId` matching when both are absent.
    const anonymous = actorWith([], null);
    expect(() => {
      requireOwnerOrPermission(anonymous, '', 'tickets.view');
    }).toThrow(UnauthenticatedError);
  });
});

describe('systemActor', () => {
  it('holds no capabilities', () => {
    expect(systemActor.permissions.size).toBe(0);
  });

  it('is refused capabilities rather than silently allowed', () => {
    // A bug in a worker must not be able to approve anything.
    expect(() => {
      requirePermission(systemActor, 'applications.approve');
    }).toThrow(ForbiddenError);
  });

  it('has no user id', () => {
    expect(() => requireUser(systemActor)).toThrow(UnauthenticatedError);
  });
});
