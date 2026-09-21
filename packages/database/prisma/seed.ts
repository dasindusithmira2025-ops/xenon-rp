import '@xenon/config/load-env';

import { allPermissions, resolvePresetPermissions, rolePresets } from '@xenon/core';

import { prisma } from '../src/client';

/**
 * Baseline seed.
 *
 * Idempotent and safe to run against production on every deploy: it only
 * upserts the structures the platform itself depends on - the capability
 * catalogue and the default roles - and never touches community data.
 *
 * Nothing here invents community content. Departments, rule text, application
 * questions, Discord role IDs and server addresses are all configured from
 * /control by staff, because guessing them would put fiction in the database
 * that somebody later has to find and delete.
 *
 * Development fixtures live in `seed-dev.ts` and are never run automatically.
 */

async function seedPermissions(): Promise<number> {
  for (const permission of allPermissions) {
    await prisma.permission.upsert({
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
  return allPermissions.length;
}

async function seedRoles(): Promise<number> {
  for (const preset of rolePresets) {
    const role = await prisma.role.upsert({
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

    const permissionRows = await prisma.permission.findMany({
      where: { key: { in: [...wanted] } },
      select: { id: true },
    });

    // createMany + skipDuplicates rather than deleteMany + createMany: this
    // adds capabilities the preset has gained since the last deploy without
    // removing any a staff member deliberately granted in /control.
    await prisma.rolePermission.createMany({
      data: permissionRows.map((permission) => ({
        roleId: role.id,
        permissionId: permission.id,
      })),
      skipDuplicates: true,
    });
  }
  return rolePresets.length;
}

async function main(): Promise<void> {
  const permissionCount = await seedPermissions();
  const roleCount = await seedRoles();

  // eslint-disable-next-line no-console -- a seed script's output is its result
  console.log(
    `Seeded ${String(permissionCount)} capabilities and ${String(roleCount)} roles.\n` +
      'Next: assign the Owner role to your account once you have signed in with Discord.\n' +
      '  pnpm --filter @xenon/database exec tsx prisma/grant-owner.ts <discord-user-id>',
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
