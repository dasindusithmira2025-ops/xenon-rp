import { allPermissions, resolvePresetPermissions, rolePresets } from '@xenon/core';

import type { Db } from './client';

/**
 * The structures the platform itself depends on: the capability catalogue and
 * the default roles.
 *
 * A function rather than a script body because three callers need it - the
 * `db:seed` CLI, deployment, and the integration suite, which rebuilds this
 * baseline between tests. One implementation means the suite exercises the
 * seed that production actually runs rather than a parallel copy of it that
 * can drift.
 *
 * Idempotent, and safe against production: every write is an upsert keyed on a
 * natural key, and nothing here invents community content.
 */
export async function seedBaseline(db: Db): Promise<{ permissions: number; roles: number }> {
  for (const permission of allPermissions) {
    await db.permission.upsert({
      where: { key: permission.key },
      create: {
        key: permission.key,
        category: permission.category,
        description: permission.description,
      },
      // Re-running after a catalogue edit refreshes the copy shown in the
      // permission matrix without disturbing any role that grants it.
      update: { category: permission.category, description: permission.description },
    });
  }

  for (const preset of rolePresets) {
    const role = await db.role.upsert({
      where: { key: preset.key },
      create: {
        key: preset.key,
        name: preset.name,
        description: preset.description,
        priority: preset.priority,
        isSystem: preset.isSystem,
      },
      // Name, description and colour are editable from /control, so they are
      // deliberately not overwritten here. Only the flags the platform relies
      // on are re-asserted.
      update: { isSystem: preset.isSystem },
    });

    const wanted = resolvePresetPermissions(preset);
    if (wanted.length === 0) continue;

    const permissionRows = await db.permission.findMany({
      where: { key: { in: [...wanted] } },
      select: { id: true },
    });

    // createMany + skipDuplicates rather than deleteMany + createMany: this
    // adds capabilities the preset has gained since the last deploy without
    // removing any a staff member deliberately granted in /control.
    await db.rolePermission.createMany({
      data: permissionRows.map((permission) => ({ roleId: role.id, permissionId: permission.id })),
      skipDuplicates: true,
    });
  }

  return { permissions: allPermissions.length, roles: rolePresets.length };
}
