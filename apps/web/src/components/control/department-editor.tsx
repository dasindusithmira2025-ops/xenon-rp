'use client';

import { ChevronDown, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import {
  Badge,
  Button,
  ConfirmDialog,
  Field,
  Input,
  Panel,
  Select,
  Textarea,
  useToast,
} from '@xenon/ui';

import { deleteDepartmentAction, upsertDepartmentAction } from '~/app/(control)/control/actions';
import { number, text } from '~/lib/form';

export interface DepartmentRecord {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly shortName: string | null;
  readonly tagline: string | null;
  readonly description: string | null;
  readonly body: string | null;
  readonly heroImageUrl: string | null;
  readonly accentColour: string | null;
  readonly recruitmentState: string;
  readonly requirements: readonly string[];
  readonly roleKey: string | null;
  readonly status: string;
  readonly sortOrder: number;
  readonly memberCount: number;
  readonly templateCount: number;
}

/**
 * Department CRUD.
 *
 * Requirements are entered one per line, which is the shape people already
 * think in and avoids a list-of-inputs widget that needs add, remove and
 * reorder controls for what is usually three bullet points.
 */
export function DepartmentEditor({
  departments,
  roles,
}: {
  departments: readonly DepartmentRecord[];
  roles: readonly { key: string; name: string }[];
}): React.ReactElement {
  const [creating, setCreating] = React.useState(false);
  const [expanded, setExpanded] = React.useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setCreating((current) => !current);
          }}
        >
          <Plus /> New department
        </Button>
      </div>

      {creating ? (
        <DepartmentForm
          department={null}
          roles={roles}
          onDone={() => {
            setCreating(false);
          }}
        />
      ) : null}

      <Panel tone="flat" pad="none" className="divide-y divide-line">
        {departments.map((department) => (
          <div key={department.id}>
            <button
              type="button"
              onClick={() => {
                setExpanded((current) => (current === department.id ? null : department.id));
              }}
              aria-expanded={expanded === department.id}
              className="flex w-full items-center gap-4 p-4 text-left transition-colors hover:bg-elevated"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="truncate text-sm text-ink">{department.name}</span>
                <span className="font-mono text-[0.625rem] text-ink-muted">
                  /{department.slug} · {department.memberCount} members · {department.templateCount}{' '}
                  applications
                </span>
              </span>

              <Badge tone={department.recruitmentState === 'OPEN' ? 'success' : 'neutral'}>
                {department.recruitmentState.toLowerCase().replace(/_/g, ' ')}
              </Badge>
              <Badge tone={department.status === 'PUBLISHED' ? 'success' : 'warning'}>
                {department.status.toLowerCase()}
              </Badge>
              <ChevronDown
                className={`size-4 shrink-0 text-ink-muted transition-transform ${
                  expanded === department.id ? 'rotate-180' : ''
                }`}
                aria-hidden
              />
            </button>

            {expanded === department.id ? (
              <div className="border-t border-line p-5">
                <DepartmentForm department={department} roles={roles} />
              </div>
            ) : null}
          </div>
        ))}
      </Panel>
    </div>
  );
}

function DepartmentForm({
  department,
  roles,
  onDone,
}: {
  department: DepartmentRecord | null;
  roles: readonly { key: string; name: string }[];
  onDone?: () => void;
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  return (
    <>
      <Panel
        tone={department === null ? 'flat' : 'ghost'}
        pad={department === null ? 'lg' : 'none'}
      >
        <form
          className="flex flex-col gap-5"
          action={(form) => {
            setErrors({});
            startTransition(async () => {
              const result = await upsertDepartmentAction(
                {
                  slug: text(form, 'slug'),
                  name: text(form, 'name'),
                  shortName: text(form, 'shortName'),
                  tagline: text(form, 'tagline'),
                  description: text(form, 'description'),
                  body: text(form, 'body'),
                  heroImageUrl: text(form, 'heroImageUrl') || null,
                  accentColour: text(form, 'accentColour') || null,
                  recruitmentState: text(form, 'recruitmentState'),
                  // One requirement per line: the shape people already think in.
                  requirements: text(form, 'requirements')
                    .split('\n')
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0),
                  roleKey: text(form, 'roleKey') || null,
                  status: text(form, 'status'),
                  sortOrder: number(form, 'sortOrder') ?? 0,
                },
                department?.id,
              );

              if (result.ok) {
                toast.success(department === null ? 'Department created' : 'Saved');
                onDone?.();
                router.refresh();
                return;
              }
              setErrors(result.fieldErrors ?? {});
              if (result.fieldErrors === undefined) toast.error('Could not save', result.message);
            });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Name" htmlFor="name" required error={errors.name}>
              <Input name="name" defaultValue={department?.name ?? ''} maxLength={64} />
            </Field>
            <Field label="Slug" htmlFor="slug" required error={errors.slug}>
              <Input name="slug" defaultValue={department?.slug ?? ''} maxLength={64} />
            </Field>
            <Field label="Short name" htmlFor="shortName" error={errors.shortName}>
              <Input name="shortName" defaultValue={department?.shortName ?? ''} maxLength={16} />
            </Field>
          </div>

          <Field label="Tagline" htmlFor="tagline" error={errors.tagline}>
            <Input name="tagline" defaultValue={department?.tagline ?? ''} maxLength={140} />
          </Field>

          <Field label="Description" htmlFor="description" error={errors.description}>
            <Textarea
              name="description"
              defaultValue={department?.description ?? ''}
              rows={3}
              maxLength={1000}
            />
          </Field>

          <Field
            label="Page body"
            htmlFor="body"
            hint="HTML. Sanitised on save: scripts, styles and event handlers are dropped."
            error={errors.body}
          >
            <Textarea
              name="body"
              defaultValue={department?.body ?? ''}
              rows={6}
              className="font-mono text-xs"
            />
          </Field>

          <Field
            label="Requirements"
            htmlFor="requirements"
            hint="One per line. Shown as a checklist on the public page."
            error={errors.requirements}
          >
            <Textarea
              name="requirements"
              defaultValue={(department?.requirements ?? []).join('\n')}
              rows={4}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Recruitment" htmlFor="recruitmentState">
              <Select
                name="recruitmentState"
                defaultValue={department?.recruitmentState ?? 'CLOSED'}
              >
                <option value="OPEN">Open</option>
                <option value="WAITLIST">Waitlist</option>
                <option value="INVITE_ONLY">Invite only</option>
                <option value="CLOSED">Closed</option>
              </Select>
            </Field>
            <Field label="Visibility" htmlFor="status">
              <Select name="status" defaultValue={department?.status ?? 'DRAFT'}>
                <option value="DRAFT">Draft</option>
                <option value="PUBLISHED">Published</option>
                <option value="ARCHIVED">Archived</option>
              </Select>
            </Field>
            <Field label="Linked role" htmlFor="roleKey" hint="Granted to members.">
              <Select name="roleKey" defaultValue={department?.roleKey ?? ''}>
                <option value="">None</option>
                {roles.map((role) => (
                  <option key={role.key} value={role.key}>
                    {role.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Order" htmlFor="sortOrder">
              <Input
                name="sortOrder"
                type="number"
                min={0}
                defaultValue={String(department?.sortOrder ?? 0)}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Hero image URL" htmlFor="heroImageUrl" error={errors.heroImageUrl}>
              <Input name="heroImageUrl" defaultValue={department?.heroImageUrl ?? ''} />
            </Field>
            <Field label="Accent colour" htmlFor="accentColour" error={errors.accentColour}>
              <Input
                name="accentColour"
                defaultValue={department?.accentColour ?? ''}
                placeholder="#4A9EFF"
              />
            </Field>
          </div>

          <div className="flex items-center justify-between gap-3">
            {department === null ? (
              <span />
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setConfirmDelete(true);
                }}
              >
                <Trash2 /> Delete
              </Button>
            )}
            <Button type="submit" variant="accent" size="sm" loading={pending}>
              {department === null ? 'Create' : 'Save'}
            </Button>
          </div>
        </form>
      </Panel>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this department?"
        description="Roster history goes with it. If it is simply not running any more, set it to archived instead."
        confirmLabel="Delete"
        tone="danger"
        loading={pending}
        onConfirm={() => {
          if (department === null) return;
          startTransition(async () => {
            const result = await deleteDepartmentAction(department.id);
            if (result.ok) {
              toast.success('Department deleted');
              setConfirmDelete(false);
              router.refresh();
              return;
            }
            toast.error('Could not delete', result.message);
          });
        }}
      />
    </>
  );
}
