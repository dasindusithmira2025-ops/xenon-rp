import { describe, expect, it } from 'vitest';

import { allPermissions, isPermissionKey } from './permissions';
import { MEMBER_ROLE_KEY, OWNER_ROLE_KEY, resolvePresetPermissions, rolePresets } from './roles';

describe('catalogue integrity', () => {
  it('has unique capability keys', () => {
    const keys = allPermissions.map((permission) => permission.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('recognises its own keys and rejects unknown ones', () => {
    for (const permission of allPermissions) {
      expect(isPermissionKey(permission.key)).toBe(true);
    }
    expect(isPermissionKey('applications.destroy_everything')).toBe(false);
    expect(isPermissionKey('')).toBe(false);
  });

  it('gives every capability a description', () => {
    for (const permission of allPermissions) {
      expect(permission.description.length, permission.key).toBeGreaterThan(0);
    }
  });
});

describe('role presets', () => {
  it('has unique keys', () => {
    const keys = rolePresets.map((preset) => preset.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('grants Owner every capability in the catalogue', () => {
    const owner = rolePresets.find((preset) => preset.key === OWNER_ROLE_KEY);
    expect(owner).toBeDefined();
    const granted = new Set(resolvePresetPermissions(owner!));
    for (const permission of allPermissions) {
      expect(granted.has(permission.key), permission.key).toBe(true);
    }
  });

  it('grants Member nothing', () => {
    const member = rolePresets.find((preset) => preset.key === MEMBER_ROLE_KEY);
    expect(resolvePresetPermissions(member!)).toHaveLength(0);
  });

  it('references only capabilities that exist', () => {
    for (const preset of rolePresets) {
      for (const permission of resolvePresetPermissions(preset)) {
        expect(isPermissionKey(permission), `${preset.key} -> ${permission}`).toBe(true);
      }
    }
  });

  it('keeps staff-report access out of the general moderator role', () => {
    // A report about a staff member must not be readable by every moderator,
    // which would include the person being reported.
    const moderator = rolePresets.find((preset) => preset.key === 'moderator');
    const granted = new Set(resolvePresetPermissions(moderator!));
    expect(granted.has('reports.staff.view')).toBe(false);
    expect(granted.has('reports.staff.manage')).toBe(false);
  });

  it('withholds system configuration from every role except Owner', () => {
    for (const preset of rolePresets) {
      if (preset.key === OWNER_ROLE_KEY) continue;
      const granted = new Set(resolvePresetPermissions(preset));
      expect(granted.has('system.manage'), preset.key).toBe(false);
    }
  });
});
