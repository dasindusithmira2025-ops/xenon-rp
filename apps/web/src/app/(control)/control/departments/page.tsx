import { prisma } from '@xenon/database';
import { listDepartmentsForStaff } from '@xenon/domain';
import { Badge, EmptyState, Panel } from '@xenon/ui';

import { ControlPage } from '~/components/control/control-page';
import { DepartmentEditor } from '~/components/control/department-editor';
import { requireCapability } from '~/server/context';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Departments' };

/**
 * /control/organisation/departments
 *
 * Adding a department is a row and some copy. There is no route to write and no
 * component to add, which is the point: the public /departments page and every
 * detail page render from here.
 */
export default async function ControlDepartmentsPage(): Promise<React.ReactElement> {
  await requireCapability('departments.manage');

  const [departments, roles] = await Promise.all([
    listDepartmentsForStaff(prisma),
    prisma.role.findMany({ select: { key: true, name: true }, orderBy: { priority: 'desc' } }),
  ]);

  return (
    <ControlPage
      title="Departments"
      lead="Player-run organisations. Published departments appear on the public site immediately."
    >
      {departments.length === 0 ? (
        <EmptyState
          title="No departments yet"
          description="Create the first one below. Nothing appears on the public site until it is published."
        />
      ) : null}

      <DepartmentEditor
        roles={roles}
        departments={departments.map((department) => ({
          id: department.id,
          slug: department.slug,
          name: department.name,
          shortName: department.shortName,
          tagline: department.tagline,
          description: department.description,
          body: department.body,
          heroImageUrl: department.heroImageUrl,
          accentColour: department.accentColour,
          recruitmentState: department.recruitmentState,
          requirements: department.requirements,
          roleKey: department.roleKey,
          status: department.status,
          sortOrder: department.sortOrder,
          memberCount: department._count.members,
          templateCount: department._count.templates,
        }))}
      />

      <Panel tone="ghost" pad="md">
        <p className="text-[0.6875rem] leading-relaxed text-ink-muted">
          A department with an open application template shows an Apply button on its public page
          automatically. Link one in the form builder by setting the template&rsquo;s department.
        </p>
      </Panel>

      <div className="flex flex-wrap gap-2">
        {departments.map((department) => (
          <Badge
            key={department.id}
            tone={department.status === 'PUBLISHED' ? 'success' : 'neutral'}
          >
            {department.name}
          </Badge>
        ))}
      </div>
    </ControlPage>
  );
}
