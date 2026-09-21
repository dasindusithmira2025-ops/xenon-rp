import Link from 'next/link';

import { permissionCatalogue } from '@xenon/core';
import { prisma } from '@xenon/database';
import { listRoles } from '@xenon/domain';
import { Avatar, Badge, Panel } from '@xenon/ui';

import { ControlPage } from '~/components/control/control-page';
import { PermissionMatrix } from '~/components/control/permission-matrix';
import { currentActor, requireCapability } from '~/server/context';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Staff and roles' };

/**
 * /control/staff
 *
 * Roles are data, not code. This screen is where a community reorganises its
 * staff structure without a deploy, and the permission matrix is rendered from
 * the capability catalogue in `@xenon/core` - so a capability added to the code
 * shows up here the moment the seed runs.
 */
export default async function StaffPage(): Promise<React.ReactElement> {
  await requireCapability('staff.view');
  const actor = await currentActor();

  const [roles, staff] = await Promise.all([
    listRoles(prisma),
    prisma.user.findMany({
      where: {
        deletedAt: null,
        roles: { some: { role: { permissions: { some: {} } } } },
      },
      select: {
        id: true,
        publicId: true,
        displayName: true,
        avatarUrl: true,
        status: true,
        roles: { include: { role: { select: { name: true, priority: true, colour: true } } } },
      },
      orderBy: { displayName: 'asc' },
    }),
  ]);

  const categories = Object.entries(permissionCatalogue).map(([key, group]) => ({
    key,
    label: group.label,
    permissions: Object.entries(group.permissions).map(([permission, description]) => ({
      key: permission,
      description,
    })),
  }));

  return (
    <ControlPage
      title="Staff and roles"
      lead="Authorization is capability-based. Roles are bundles of capabilities that you can rearrange here without a deploy."
    >
      <section className="flex flex-col gap-3">
        <h2 className="x-eyebrow">Staff ({staff.length})</h2>
        <Panel tone="flat" pad="none" className="divide-y divide-line">
          {staff.map((member) => (
            <Link
              key={member.id}
              href={`/control/players/${member.publicId}`}
              className="flex flex-wrap items-center gap-3 p-4 transition-colors hover:bg-elevated"
            >
              <Avatar src={member.avatarUrl} name={member.displayName} size={28} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm text-ink">
                  {member.displayName ?? member.publicId}
                </span>
                <span className="font-mono text-[0.625rem] text-ink-muted">{member.publicId}</span>
              </span>

              <span className="flex flex-wrap gap-1.5">
                {member.roles
                  .sort((a, b) => b.role.priority - a.role.priority)
                  .map((assignment) => (
                    <Badge key={assignment.roleId} tone="chrome">
                      {assignment.role.name}
                    </Badge>
                  ))}
              </span>

              {member.status === 'ACTIVE' ? null : (
                <Badge tone="danger">{member.status.toLowerCase()}</Badge>
              )}
            </Link>
          ))}
        </Panel>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="x-eyebrow">Permission matrix</h2>
        <PermissionMatrix
          categories={categories}
          canManage={actor.permissions.has('staff.manage')}
          heldByViewer={[...actor.permissions]}
          isOwner={actor.roleKeys.has('owner')}
          roles={roles.map((role) => ({
            id: role.id,
            key: role.key,
            name: role.name,
            priority: role.priority,
            isSystem: role.isSystem,
            memberCount: role._count.users,
            permissions: role.permissions.map((grant) => grant.permission.key),
          }))}
        />
      </section>
    </ControlPage>
  );
}
