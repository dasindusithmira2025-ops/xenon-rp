import { describe, expect, it } from 'vitest';

import { planRoleSync } from './role-sync';

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
