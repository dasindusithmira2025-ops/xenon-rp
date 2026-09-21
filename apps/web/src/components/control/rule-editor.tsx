'use client';

import { ChevronDown, Plus, Trash2, Upload } from 'lucide-react';
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

import {
  deleteRuleAction,
  publishRuleSetAction,
  upsertRuleAction,
} from '~/app/(control)/control/actions';
import { number, text } from '~/lib/form';

export interface RuleRecord {
  readonly id: string;
  readonly code: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly examples: string | null;
  readonly severity: string;
  readonly aliases: readonly string[];
  readonly status: string;
  readonly sortOrder: number;
}

export interface RuleCategoryRecord {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly rules: readonly RuleRecord[];
}

const severityTone: Record<string, 'neutral' | 'info' | 'warning' | 'danger'> = {
  GUIDELINE: 'neutral',
  STANDARD: 'info',
  SERIOUS: 'warning',
  ZERO_TOLERANCE: 'danger',
};

export function RuleEditor({
  categories,
  canPublish,
  currentVersion,
  draftCount,
}: {
  categories: readonly RuleCategoryRecord[];
  canPublish: boolean;
  currentVersion: number | null;
  draftCount: number;
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [creating, setCreating] = React.useState(false);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [publishing, setPublishing] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  return (
    <>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="x-eyebrow">Rules</h2>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setCreating((current) => !current);
              }}
            >
              <Plus /> New rule
            </Button>
            {canPublish ? (
              <Button
                variant="accent"
                size="sm"
                onClick={() => {
                  setPublishing(true);
                }}
              >
                <Upload /> Publish a ruleset
              </Button>
            ) : null}
          </div>
        </div>

        {creating ? (
          <RuleForm
            rule={null}
            categories={categories}
            onDone={() => {
              setCreating(false);
            }}
          />
        ) : null}

        {categories.map((category) => (
          <section key={category.id} className="flex flex-col gap-2">
            <h3 className="x-eyebrow text-xenon">{category.name}</h3>

            <Panel tone="flat" pad="none" className="divide-y divide-line">
              {category.rules.length === 0 ? (
                <p className="p-4 text-xs text-ink-muted">No rules in this category yet.</p>
              ) : (
                category.rules.map((rule) => (
                  <div key={rule.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setExpanded((current) => (current === rule.id ? null : rule.id));
                      }}
                      aria-expanded={expanded === rule.id}
                      className="flex w-full items-center gap-4 p-4 text-left transition-colors hover:bg-elevated"
                    >
                      <code className="w-16 shrink-0 font-mono text-[0.6875rem] text-xenon">
                        {rule.code}
                      </code>
                      <span className="min-w-0 flex-1 truncate text-sm text-ink">{rule.title}</span>

                      {rule.aliases.length === 0 ? null : (
                        <span className="hidden font-mono text-[0.625rem] text-ink-muted sm:inline">
                          {rule.aliases.slice(0, 2).join(', ')}
                        </span>
                      )}
                      <Badge tone={severityTone[rule.severity] ?? 'neutral'}>
                        {rule.severity.toLowerCase().replace(/_/g, ' ')}
                      </Badge>
                      <Badge tone={rule.status === 'PUBLISHED' ? 'success' : 'warning'}>
                        {rule.status.toLowerCase()}
                      </Badge>
                      <ChevronDown
                        className={`size-4 shrink-0 text-ink-muted transition-transform ${
                          expanded === rule.id ? 'rotate-180' : ''
                        }`}
                        aria-hidden
                      />
                    </button>

                    {expanded === rule.id ? (
                      <div className="border-t border-line p-5">
                        <RuleForm rule={rule} categoryId={category.id} categories={categories} />
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </Panel>
          </section>
        ))}
      </div>

      <ConfirmDialog
        open={publishing}
        onOpenChange={setPublishing}
        title={
          currentVersion === null
            ? 'Publish the first ruleset?'
            : `Publish version ${String(currentVersion + 1)}?`
        }
        description={
          <>
            Every published rule is frozen into a new numbered ruleset and every player is asked to
            accept it again before they can apply for anything.
            {draftCount > 0 ? (
              <>
                {' '}
                <strong className="text-warning">
                  {draftCount} rule{draftCount === 1 ? ' is' : 's are'} still in draft and will not
                  be included.
                </strong>
              </>
            ) : null}
          </>
        }
        confirmLabel="Publish"
        loading={pending}
        onConfirm={() => {
          startTransition(async () => {
            const result = await publishRuleSetAction('');
            if (result.ok) {
              toast.success(`Version ${String(result.data.version)} published`);
              setPublishing(false);
              router.refresh();
              return;
            }
            toast.error('Could not publish', result.message);
          });
        }}
      />
    </>
  );
}

function RuleForm({
  rule,
  categoryId,
  categories,
  onDone,
}: {
  rule: RuleRecord | null;
  categoryId?: string;
  categories: readonly RuleCategoryRecord[];
  onDone?: () => void;
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  return (
    <>
      <Panel tone={rule === null ? 'flat' : 'ghost'} pad={rule === null ? 'lg' : 'none'}>
        <form
          className="flex flex-col gap-5"
          action={(form) => {
            setErrors({});
            startTransition(async () => {
              const result = await upsertRuleAction(
                {
                  categoryId: text(form, 'categoryId'),
                  code: text(form, 'code'),
                  slug: text(form, 'slug'),
                  title: text(form, 'title'),
                  description: text(form, 'description'),
                  examples: text(form, 'examples'),
                  severity: text(form, 'severity'),
                  aliases: text(form, 'aliases')
                    .split(',')
                    .map((alias) => alias.trim())
                    .filter((alias) => alias.length > 0),
                  status: text(form, 'status'),
                  sortOrder: number(form, 'sortOrder') ?? 0,
                  changeNote: text(form, 'changeNote'),
                },
                rule?.id,
              );

              if (result.ok) {
                toast.success(rule === null ? 'Rule created' : 'Saved as a new revision');
                onDone?.();
                router.refresh();
                return;
              }
              setErrors(result.fieldErrors ?? {});
              if (result.fieldErrors === undefined) toast.error('Could not save', result.message);
            });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Category" htmlFor="categoryId" required>
              <Select name="categoryId" defaultValue={categoryId ?? categories[0]?.id ?? ''}>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Code" htmlFor="code" required error={errors.code}>
              <Input
                name="code"
                defaultValue={rule?.code ?? ''}
                placeholder="GEN-4"
                className="font-mono"
              />
            </Field>
            <Field label="Anchor" htmlFor="slug" required error={errors.slug}>
              <Input name="slug" defaultValue={rule?.slug ?? ''} maxLength={64} />
            </Field>
            <Field label="Order" htmlFor="sortOrder">
              <Input
                name="sortOrder"
                type="number"
                min={0}
                defaultValue={String(rule?.sortOrder ?? 0)}
              />
            </Field>
          </div>

          <Field label="Title" htmlFor="title" required error={errors.title}>
            <Input name="title" defaultValue={rule?.title ?? ''} maxLength={140} />
          </Field>

          <Field label="Rule" htmlFor="description" required error={errors.description}>
            <Textarea
              name="description"
              defaultValue={rule?.description ?? ''}
              rows={5}
              maxLength={8000}
            />
          </Field>

          <Field
            label="Worked example"
            htmlFor="examples"
            hint="Rendered as a distinct block. Concrete beats abstract."
            error={errors.examples}
          >
            <Textarea
              name="examples"
              defaultValue={rule?.examples ?? ''}
              rows={3}
              maxLength={4000}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label="Aliases"
              htmlFor="aliases"
              hint="Comma separated. What people search for."
              error={errors.aliases}
            >
              <Input name="aliases" defaultValue={(rule?.aliases ?? []).join(', ')} />
            </Field>
            <Field label="Severity" htmlFor="severity">
              <Select name="severity" defaultValue={rule?.severity ?? 'STANDARD'}>
                <option value="GUIDELINE">Guideline</option>
                <option value="STANDARD">Standard</option>
                <option value="SERIOUS">Serious</option>
                <option value="ZERO_TOLERANCE">Zero tolerance</option>
              </Select>
            </Field>
            <Field label="Status" htmlFor="status">
              <Select name="status" defaultValue={rule?.status ?? 'DRAFT'}>
                <option value="DRAFT">Draft</option>
                <option value="PUBLISHED">Published</option>
                <option value="ARCHIVED">Archived</option>
              </Select>
            </Field>
          </div>

          <Field
            label="Change note"
            htmlFor="changeNote"
            hint="Recorded on the revision. Useful when somebody asks why the wording changed."
          >
            <Input name="changeNote" maxLength={300} />
          </Field>

          <div className="flex items-center justify-between gap-3">
            {rule === null ? (
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
              {rule === null ? 'Create' : 'Save revision'}
            </Button>
          </div>
        </form>
      </Panel>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this rule?"
        description="Its revisions go with it. Any ruleset already published keeps its frozen copy, so historical acceptances stay meaningful."
        confirmLabel="Delete"
        tone="danger"
        loading={pending}
        onConfirm={() => {
          if (rule === null) return;
          startTransition(async () => {
            const result = await deleteRuleAction(rule.id);
            if (result.ok) {
              toast.success('Rule deleted');
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
