import { getTemplateTree } from '@xenon/applications';
import { prisma } from '@xenon/database';
import { Badge } from '@xenon/ui';

import { ControlPage } from '~/components/control/control-page';
import { TemplateBuilder } from '~/components/control/template-builder';
import { requireCapability } from '~/server/context';
import { loadOrStatus } from '~/server/load';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Builder' };

/**
 * /control/applications/templates/[slug]
 *
 * The form builder. Settings, sections and questions, with a live preview of
 * exactly what an applicant sees - including which questions their answers
 * would hide.
 *
 * There is no raw JSON editor. The whole point of storing forms as rows is that
 * a staff member who has never seen JSON can build one.
 */
export default async function BuilderPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactElement> {
  const { slug } = await params;
  await requireCapability('applications.manage_templates');

  const [template, departments, roles] = await Promise.all([
    loadOrStatus(getTemplateTree(prisma, slug)),
    prisma.department.findMany({ select: { id: true, name: true }, orderBy: { sortOrder: 'asc' } }),
    prisma.role.findMany({ select: { key: true, name: true }, orderBy: { priority: 'desc' } }),
  ]);

  const questionCount = template.sections.reduce(
    (total, section) => total + section.questions.length,
    0,
  );

  return (
    <ControlPage
      title={template.name}
      lead={`${String(template.sections.length)} sections · ${String(questionCount)} questions · prefix ${template.publicIdPrefix}`}
      breadcrumb={{ href: '/control/applications/templates', label: 'Form builder' }}
      actions={
        <>
          <Badge tone={template.status === 'OPEN' ? 'success' : 'neutral'}>
            {template.status.toLowerCase()}
          </Badge>
          {template.grantsWhitelist ? <Badge tone="info">Grants whitelist</Badge> : null}
        </>
      }
    >
      <TemplateBuilder
        departments={departments}
        roles={roles}
        template={{
          id: template.id,
          slug: template.slug,
          name: template.name,
          summary: template.summary,
          description: template.description,
          publicIdPrefix: template.publicIdPrefix,
          departmentId: template.departmentId,
          status: template.status,
          opensAt: template.opensAt?.toISOString().slice(0, 10) ?? null,
          closesAt: template.closesAt?.toISOString().slice(0, 10) ?? null,
          minimumAccountAgeDays: template.minimumAccountAgeDays,
          requiresGuildMember: template.requiresGuildMember,
          requiresFivemLink: template.requiresFivemLink,
          requiresRulesAccepted: template.requiresRulesAccepted,
          requiresCharacter: template.requiresCharacter,
          requiredRoleKeys: template.requiredRoleKeys,
          blockedRoleKeys: template.blockedRoleKeys,
          rejectionCooldownDays: template.rejectionCooldownDays,
          maxConcurrent: template.maxConcurrent,
          interviewRequired: template.interviewRequired,
          allowResubmission: template.allowResubmission,
          autoAssignReviewer: template.autoAssignReviewer,
          expiryDays: template.expiryDays,
          reviewChannelId: template.reviewChannelId,
          notifyRoleId: template.notifyRoleId,
          grantRoleKeys: template.grantRoleKeys,
          grantsWhitelist: template.grantsWhitelist,
          sortOrder: template.sortOrder,
        }}
        sections={template.sections.map((section) => ({
          id: section.id,
          title: section.title,
          description: section.description,
          sortOrder: section.sortOrder,
          questions: section.questions.map((question) => ({
            id: question.id,
            key: question.key,
            type: question.type,
            label: question.label,
            helpText: question.helpText,
            placeholder: question.placeholder,
            required: question.required,
            sortOrder: question.sortOrder,
            minLength: question.minLength,
            maxLength: question.maxLength,
            minValue: question.minValue,
            maxValue: question.maxValue,
            staffOnly: question.staffOnly,
            visibleWhenQuestionKey: question.visibleWhenQuestionKey,
            visibleWhenOperator: question.visibleWhenOperator,
            visibleWhenValue: question.visibleWhenValue,
            options: question.options.map((option) => ({
              value: option.value,
              label: option.label,
            })),
          })),
        }))}
      />
    </ControlPage>
  );
}
