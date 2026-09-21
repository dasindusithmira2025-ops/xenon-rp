import { ArrowRight, Plus } from 'lucide-react';
import Link from 'next/link';

import { listTemplatesForStaff } from '@xenon/applications';
import { prisma } from '@xenon/database';
import { Badge, Button, EmptyState, Panel } from '@xenon/ui';

import { ControlPage } from '~/components/control/control-page';
import { NewTemplateButton } from '~/components/control/new-template-button';
import { requireCapability } from '~/server/context';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Form builder' };

const statusTone = {
  OPEN: 'success',
  CLOSED: 'neutral',
  DRAFT: 'warning',
  ARCHIVED: 'neutral',
} as const;

/**
 * /control/applications/templates
 *
 * The list of application types. Each one is a form definition stored as rows,
 * which is why a new department intake needs an afternoon here and no deploy.
 */
export default async function TemplatesPage(): Promise<React.ReactElement> {
  await requireCapability('applications.manage_templates');

  const [templates, departments] = await Promise.all([
    listTemplatesForStaff(prisma),
    prisma.department.findMany({ select: { id: true, name: true }, orderBy: { sortOrder: 'asc' } }),
  ]);

  return (
    <ControlPage
      title="Form builder"
      lead="Application types are data. Add, edit and open them here without touching code."
      actions={<NewTemplateButton departments={departments} />}
    >
      {templates.length === 0 ? (
        <EmptyState
          icon={<Plus className="size-6" />}
          title="No application types yet"
          description="Create the first one. A whitelist intake that grants access is the usual place to start."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {templates.map((template) => {
            const questionCount = template._count.sections;
            return (
              <Panel key={template.id} tone="flat" pad="lg">
                <div className="flex flex-wrap items-center gap-4">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <h2 className="font-display text-base font-bold text-ink">{template.name}</h2>
                      <Badge tone={statusTone[template.status]}>
                        {template.status.toLowerCase()}
                      </Badge>
                      {template.grantsWhitelist ? (
                        <Badge tone="info">Grants whitelist</Badge>
                      ) : null}
                      {template.interviewRequired ? <Badge tone="warning">Interview</Badge> : null}
                    </div>
                    <p className="font-mono text-[0.625rem] text-ink-muted">
                      /{template.slug} · prefix {template.publicIdPrefix} · {questionCount} sections
                      · {template._count.submissions} submissions
                      {template.department === null ? null : <> · {template.department.name}</>}
                    </p>
                  </div>

                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/control/applications/templates/${template.slug}`}>
                      Open builder <ArrowRight />
                    </Link>
                  </Button>
                </div>
              </Panel>
            );
          })}
        </div>
      )}

      <Panel tone="ghost" pad="md">
        <p className="text-[0.6875rem] leading-relaxed text-ink-muted">
          A template with submissions cannot be deleted, only archived: the answers behind those
          submissions are what an appeal is decided against.
        </p>
      </Panel>
    </ControlPage>
  );
}
