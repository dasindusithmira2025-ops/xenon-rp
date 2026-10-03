import { describe, expect, it, vi } from 'vitest';

import type { Db } from '@xenon/database';

import { planRoleSync, syncUserRoles } from './role-sync';

/**
 * The behaviour these cover is the one that would otherwise quietly destroy a
 * community's Discord: synchronisation must only ever touch roles Xenon
 * manages. Colour roles, event roles and pingable groups are not ours.
 */
describe('planRoleSync', () => {
  const MANAGED = ['role-staff', 'role-whitelisted', 'role-police'];

  it('adds a desired role the member does not hold', () => {
    const plan = planRoleSync(MANAGED, ['role-whitelisted'], []);
    expect(plan.add).toEqual(['role-whitelisted']);
    expect(plan.remove).toEqual([]);
  });

  it('removes a managed role the member should no longer hold', () => {
    const plan = planRoleSync(MANAGED, [], ['role-whitelisted']);
    expect(plan.add).toEqual([]);
    expect(plan.remove).toEqual(['role-whitelisted']);
  });

  it('leaves unmanaged community roles completely alone', () => {
    const plan = planRoleSync(
      MANAGED,
      ['role-whitelisted'],
      ['role-colour-pink', 'role-events', 'role-whitelisted'],
    );
    expect(plan.add).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.unchanged).toBe(1);
  });

  it('does nothing when the member is already correct', () => {
    const plan = planRoleSync(
      MANAGED,
      ['role-staff', 'role-police'],
      ['role-staff', 'role-police'],
    );
    expect(plan.add).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.unchanged).toBe(2);
  });

  it('is idempotent: applying the plan then re-planning yields nothing to do', () => {
    const first = planRoleSync(MANAGED, ['role-staff'], ['role-whitelisted']);
    const applied = ['role-whitelisted', ...first.add].filter(
      (role) => !first.remove.includes(role),
    );
    const second = planRoleSync(MANAGED, ['role-staff'], applied);
    expect(second.add).toEqual([]);
    expect(second.remove).toEqual([]);
  });

  it('strips every managed role when nothing is desired, as for a ban', () => {
    const plan = planRoleSync(MANAGED, [], ['role-staff', 'role-police', 'role-colour-pink']);
    expect([...plan.remove].sort()).toEqual(['role-police', 'role-staff']);
  });

  it('adds a desired role even when it is not in the managed set', () => {
    // A mapping that was just created is desired before the managed snapshot
    // has caught up; refusing to add it would leave the grant unapplied.
    const plan = planRoleSync([], ['role-new'], []);
    expect(plan.add).toEqual(['role-new']);
  });
});

describe('syncUserRoles', () => {
  function setup({
    current = [] as readonly string[],
    desired = true,
    whitelistState = 'NONE',
    whitelistedRoleId = null as string | null,
    userExists = true,
    accountLinked = true,
    prerequisite = { roleFound: true, hierarchyBlocked: false, manageRolesMissing: false },
  }: {
    current?: readonly string[];
    desired?: boolean;
    whitelistState?: string;
    whitelistedRoleId?: string | null;
    userExists?: boolean;
    accountLinked?: boolean;
    prerequisite?: {
      roleFound: boolean;
      hierarchyBlocked: boolean;
      manageRolesMissing: boolean;
    };
  } = {}) {
    const mappingUpdateMany = vi.fn(() => Promise.resolve({ count: 1 }));
    const db = {
      user: {
        findUnique: vi.fn(() =>
          Promise.resolve(
            userExists
              ? {
                  status: 'ACTIVE',
                  whitelistState,
                  discordAccount: accountLinked ? { discordId: 'discord-user' } : null,
                  roles: desired ? [{ roleId: 'xenon-role' }] : [],
                }
              : null,
          ),
        ),
      },
      discordGuild: {
        findFirst: vi.fn(() => Promise.resolve({ id: 'guild-row', guildId: 'guild-snowflake' })),
      },
      discordManagedResource: {
        findUnique: vi.fn(() =>
          Promise.resolve(
            whitelistedRoleId === null
              ? null
              : { discordResourceId: whitelistedRoleId, managed: true },
          ),
        ),
      },
      discordRoleMapping: {
        findMany: vi.fn(() =>
          Promise.resolve([
            {
              id: 'mapping-row',
              roleId: 'xenon-role',
              discordRoleId: 'discord-role',
            },
          ]),
        ),
        updateMany: mappingUpdateMany,
      },
    } as unknown as Db;

    const calls = {
      addRole: vi.fn(() => Promise.resolve()),
      removeRole: vi.fn(() => Promise.resolve()),
    };
    const port = {
      memberRoles: vi.fn((_discordUserId: string): Promise<readonly string[] | null> =>
        Promise.resolve(current),
      ),
      addRole: calls.addRole,
      removeRole: calls.removeRole,
      canManageRole: vi.fn(() => Promise.resolve(prerequisite)),
    };

    return { db, port, calls, mappingUpdateMany };
  }

  it('grants and removes mapped roles idempotently', async () => {
    const grant = setup();
    const granted = await syncUserRoles(grant.db, grant.port, 'xenon-user');
    expect(grant.calls.addRole).toHaveBeenCalledWith('discord-user', 'discord-role');
    expect(granted.applied).toBe(true);

    const unchanged = setup({ current: ['discord-role'] });
    const alreadyGranted = await syncUserRoles(unchanged.db, unchanged.port, 'xenon-user');
    expect(unchanged.calls.addRole).not.toHaveBeenCalled();
    expect(unchanged.calls.removeRole).not.toHaveBeenCalled();
    expect(alreadyGranted.applied).toBe(true);

    const removal = setup({ current: ['discord-role'], desired: false });
    const removed = await syncUserRoles(removal.db, removal.port, 'xenon-user');
    expect(removal.calls.removeRole).toHaveBeenCalledWith('discord-user', 'discord-role');
    expect(removed.applied).toBe(true);
  });

  it('records a hierarchy block without touching the member role set', async () => {
    const fixture = setup({
      prerequisite: { roleFound: true, hierarchyBlocked: true, manageRolesMissing: false },
    });

    const outcome = await syncUserRoles(fixture.db, fixture.port, 'xenon-user');

    expect(outcome.blocked).toEqual(['discord-role']);
    expect(outcome.applied).toBe(false);
    expect(fixture.calls.addRole).not.toHaveBeenCalled();
    expect(fixture.mappingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { hierarchyBlocked: true, lastError: 'Bot role is below this role' },
      }),
    );
  });

  it('reports missing role and permission failures as permanent diagnostics', async () => {
    const missingRole = setup({
      prerequisite: { roleFound: false, hierarchyBlocked: false, manageRolesMissing: false },
    });
    const missing = await syncUserRoles(missingRole.db, missingRole.port, 'xenon-user');
    expect(missing.permanentErrors[0]).toContain('no longer exists');
    expect(missingRole.calls.addRole).not.toHaveBeenCalled();

    const missingPermission = setup({
      prerequisite: { roleFound: true, hierarchyBlocked: false, manageRolesMissing: true },
    });
    const permission = await syncUserRoles(
      missingPermission.db,
      missingPermission.port,
      'xenon-user',
    );
    expect(permission.permanentErrors[0]).toContain('MANAGE_ROLES');
    expect(missingPermission.calls.addRole).not.toHaveBeenCalled();
  });

  it('does not retry a member who is confirmed absent from the guild', async () => {
    const fixture = setup();
    fixture.port.memberRoles.mockResolvedValue(null);

    const outcome = await syncUserRoles(fixture.db, fixture.port, 'xenon-user');

    expect(outcome.memberMissing).toBe(true);
    expect(fixture.calls.addRole).not.toHaveBeenCalled();
  });

  it('treats deleted Xenon users as permanent and unlinked existing users as pending', async () => {
    const stale = setup({ userExists: false });
    const staleOutcome = await syncUserRoles(stale.db, stale.port, 'deleted-user');
    expect(staleOutcome.permanentErrors).toContain('Xenon user no longer exists');
    expect(staleOutcome.errors).toEqual([]);

    const pending = setup({ accountLinked: false });
    const pendingOutcome = await syncUserRoles(pending.db, pending.port, 'unlinked-user');
    expect(pendingOutcome.errors).toContain('No linked Discord account');
    expect(pendingOutcome.permanentErrors).toEqual([]);
  });

  it('mirrors the whitelist state onto the provisioned Whitelisted role', async () => {
    const approved = setup({ desired: false, whitelistState: 'APPROVED', whitelistedRoleId: 'wl' });
    await syncUserRoles(approved.db, approved.port, 'xenon-user');
    expect(approved.calls.addRole).toHaveBeenCalledWith('discord-user', 'wl');

    const revoked = setup({
      desired: false,
      current: ['wl', 'unrelated'],
      whitelistState: 'REVOKED',
      whitelistedRoleId: 'wl',
    });
    await syncUserRoles(revoked.db, revoked.port, 'xenon-user');
    expect(revoked.calls.removeRole).toHaveBeenCalledWith('discord-user', 'wl');
    expect(revoked.calls.removeRole).not.toHaveBeenCalledWith('discord-user', 'unrelated');
  });
});
