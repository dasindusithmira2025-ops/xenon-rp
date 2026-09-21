'use client';

import { ChevronDown, ChevronUp, Eye, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import {
  Badge,
  Button,
  Choice,
  ConfirmDialog,
  Field,
  Input,
  Panel,
  Select,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  useToast,
} from '@xenon/ui';
import type { AnswerValue } from '@xenon/validation';

import {
  deleteQuestionAction,
  deleteSectionAction,
  reorderQuestionsAction,
  saveQuestionAction,
  saveSectionAction,
  saveTemplateAction,
} from '~/app/(control)/control/applications/templates/actions';
import { QuestionField } from '~/components/applications/question-field';
import { number, text, textList } from '~/lib/form';

/**
 * The form builder.
 *
 * Three tabs: settings, questions, preview. The preview is the reason this
 * works - it renders the applicant's view through the same component the real
 * form uses, so conditional visibility can be tested by answering the question
 * that controls it rather than by reasoning about it.
 *
 * Reordering is up/down buttons rather than drag and drop. Drag is a large
 * dependency, is poor with a keyboard, and questions get reordered roughly
 * twice in a template's life.
 */

export interface BuilderQuestion {
  readonly id: string;
  readonly key: string;
  readonly type: string;
  readonly label: string;
  readonly helpText: string | null;
  readonly placeholder: string | null;
  readonly required: boolean;
  readonly sortOrder: number;
  readonly minLength: number | null;
  readonly maxLength: number | null;
  readonly minValue: number | null;
  readonly maxValue: number | null;
  readonly staffOnly: boolean;
  readonly visibleWhenQuestionKey: string | null;
  readonly visibleWhenOperator: string | null;
  readonly visibleWhenValue: string | null;
  readonly options: readonly { value: string; label: string }[];
}

export interface BuilderSection {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly sortOrder: number;
  readonly questions: readonly BuilderQuestion[];
}

export interface BuilderTemplate {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly summary: string | null;
  readonly description: string | null;
  readonly publicIdPrefix: string;
  readonly departmentId: string | null;
  readonly status: string;
  readonly opensAt: string | null;
  readonly closesAt: string | null;
  readonly minimumAccountAgeDays: number;
  readonly requiresGuildMember: boolean;
  readonly requiresFivemLink: boolean;
  readonly requiresRulesAccepted: boolean;
  readonly requiresCharacter: boolean;
  readonly requiredRoleKeys: readonly string[];
  readonly blockedRoleKeys: readonly string[];
  readonly rejectionCooldownDays: number;
  readonly maxConcurrent: number;
  readonly interviewRequired: boolean;
  readonly allowResubmission: boolean;
  readonly autoAssignReviewer: boolean;
  readonly expiryDays: number;
  readonly reviewChannelId: string | null;
  readonly notifyRoleId: string | null;
  readonly grantRoleKeys: readonly string[];
  readonly grantsWhitelist: boolean;
  readonly sortOrder: number;
}

const questionTypes = [
  ['SHORT_TEXT', 'Short text'],
  ['LONG_TEXT', 'Long text'],
  ['NUMBER', 'Number'],
  ['DATE', 'Date'],
  ['SELECT', 'Dropdown'],
  ['RADIO', 'Pick one'],
  ['MULTI_SELECT', 'Pick several'],
  ['CHECKBOX', 'Checkboxes'],
  ['BOOLEAN', 'Yes or no'],
  ['ACKNOWLEDGEMENT', 'Acknowledgement'],
  ['CHARACTER_SELECT', 'Character picker'],
  ['IMAGE', 'Image upload'],
  ['FILE', 'File upload'],
] as const;

const needsOptions = new Set(['SELECT', 'RADIO', 'MULTI_SELECT', 'CHECKBOX']);

export function TemplateBuilder({
  template,
  sections,
  departments,
  roles,
}: {
  template: BuilderTemplate;
  sections: readonly BuilderSection[];
  departments: readonly { id: string; name: string }[];
  roles: readonly { key: string; name: string }[];
}): React.ReactElement {
  return (
    <Tabs defaultValue="questions" className="flex flex-col gap-6">
      <TabsList>
        <TabsTrigger value="questions">Questions</TabsTrigger>
        <TabsTrigger value="settings">Settings</TabsTrigger>
        <TabsTrigger value="preview">
          <Eye className="mr-1.5 size-3.5" /> Preview
        </TabsTrigger>
      </TabsList>

      <TabsContent value="questions">
        <QuestionsTab template={template} sections={sections} />
      </TabsContent>

      <TabsContent value="settings">
        <SettingsTab template={template} departments={departments} roles={roles} />
      </TabsContent>

      <TabsContent value="preview">
        <PreviewTab sections={sections} />
      </TabsContent>
    </Tabs>
  );
}

// --- Questions ---------------------------------------------------------------

function QuestionsTab({
  template,
  sections,
}: {
  template: BuilderTemplate;
  sections: readonly BuilderSection[];
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [addingSection, setAddingSection] = React.useState(false);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [addingTo, setAddingTo] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const allKeys = sections.flatMap((section) =>
    section.questions.map((question) => ({ key: question.key, label: question.label })),
  );

  const move = (section: BuilderSection, index: number, direction: -1 | 1): void => {
    const ordered = [...section.questions];
    const target = index + direction;
    if (target < 0 || target >= ordered.length) return;

    const [moved] = ordered.splice(index, 1);
    if (moved === undefined) return;
    ordered.splice(target, 0, moved);

    startTransition(async () => {
      const result = await reorderQuestionsAction(ordered.map((question) => question.id));
      if (result.ok) {
        router.refresh();
        return;
      }
      toast.error('Could not reorder', result.message);
    });
  };

  return (
    <div className="flex flex-col gap-5">
      {sections.map((section) => (
        <Panel key={section.id} tone="flat" pad="none">
          <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium text-ink">{section.title}</span>
              {section.description === null ? null : (
                <span className="truncate text-xs text-ink-muted">{section.description}</span>
              )}
            </div>
            <span className="font-mono text-[0.625rem] text-ink-muted">
              {section.questions.length} questions
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setAddingTo(addingTo === section.id ? null : section.id);
              }}
            >
              <Plus /> Question
            </Button>
            <DeleteSectionButton sectionId={section.id} />
          </div>

          <div className="divide-y divide-line">
            {section.questions.map((question, index) => (
              <div key={question.id}>
                <div className="flex items-center gap-3 p-3.5">
                  <div className="flex shrink-0 flex-col">
                    <button
                      type="button"
                      disabled={index === 0 || pending}
                      onClick={() => {
                        move(section, index, -1);
                      }}
                      aria-label="Move up"
                      className="text-ink-muted transition-colors hover:text-ink disabled:opacity-30"
                    >
                      <ChevronUp className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={index === section.questions.length - 1 || pending}
                      onClick={() => {
                        move(section, index, 1);
                      }}
                      aria-label="Move down"
                      className="text-ink-muted transition-colors hover:text-ink disabled:opacity-30"
                    >
                      <ChevronDown className="size-3.5" />
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      setEditing(editing === question.id ? null : question.id);
                    }}
                    className="flex min-w-0 flex-1 flex-col text-left"
                  >
                    <span className="truncate text-sm text-ink">{question.label}</span>
                    <span className="font-mono text-[0.625rem] text-ink-muted">
                      {question.key} · {question.type.toLowerCase().replace(/_/g, ' ')}
                      {question.visibleWhenQuestionKey === null ? null : (
                        <> · conditional on {question.visibleWhenQuestionKey}</>
                      )}
                    </span>
                  </button>

                  {question.required ? <Badge tone="success">Required</Badge> : null}
                  {question.staffOnly ? <Badge tone="warning">Staff only</Badge> : null}
                </div>

                {editing === question.id ? (
                  <div className="border-t border-line bg-black/30 p-5">
                    <QuestionForm
                      sectionId={section.id}
                      question={question}
                      otherQuestions={allKeys.filter((entry) => entry.key !== question.key)}
                      onDone={() => {
                        setEditing(null);
                      }}
                    />
                  </div>
                ) : null}
              </div>
            ))}

            {addingTo === section.id ? (
              <div className="bg-black/30 p-5">
                <QuestionForm
                  sectionId={section.id}
                  question={null}
                  otherQuestions={allKeys}
                  onDone={() => {
                    setAddingTo(null);
                  }}
                />
              </div>
            ) : null}
          </div>
        </Panel>
      ))}

      {addingSection ? (
        <SectionForm
          templateId={template.id}
          nextOrder={sections.length}
          onDone={() => {
            setAddingSection(false);
          }}
        />
      ) : (
        <Button
          variant="outline"
          onClick={() => {
            setAddingSection(true);
          }}
        >
          <Plus /> Add a section
        </Button>
      )}
    </div>
  );
}

function SectionForm({
  templateId,
  nextOrder,
  onDone,
}: {
  templateId: string;
  nextOrder: number;
  onDone: () => void;
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = React.useTransition();

  return (
    <Panel tone="raised" pad="lg" edgeLight>
      <form
        className="flex flex-col gap-4"
        action={(form) => {
          startTransition(async () => {
            const result = await saveSectionAction({
              templateId,
              title: text(form, 'title'),
              description: text(form, 'description'),
              sortOrder: nextOrder,
            });
            if (result.ok) {
              toast.success('Section added');
              onDone();
              router.refresh();
              return;
            }
            toast.error('Could not add', result.message);
          });
        }}
      >
        <Field label="Section title" htmlFor="title" required>
          <Input name="title" placeholder="About you" maxLength={80} />
        </Field>
        <Field label="Description" htmlFor="description">
          <Textarea name="description" rows={2} maxLength={500} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" variant="accent" size="sm" loading={pending}>
            Add section
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function DeleteSectionButton({ sectionId }: { sectionId: string }): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Delete section"
        onClick={() => {
          setOpen(true);
        }}
      >
        <Trash2 />
      </Button>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete this section?"
        description="Every question in it goes too, along with any answers already given to them."
        confirmLabel="Delete"
        tone="danger"
        loading={pending}
        onConfirm={() => {
          startTransition(async () => {
            const result = await deleteSectionAction(sectionId);
            if (result.ok) {
              toast.success('Section deleted');
              setOpen(false);
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

function QuestionForm({
  sectionId,
  question,
  otherQuestions,
  onDone,
}: {
  sectionId: string;
  question: BuilderQuestion | null;
  otherQuestions: readonly { key: string; label: string }[];
  onDone: () => void;
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [type, setType] = React.useState(question?.type ?? 'SHORT_TEXT');
  const [required, setRequired] = React.useState(question?.required ?? false);
  const [staffOnly, setStaffOnly] = React.useState(question?.staffOnly ?? false);
  const [conditional, setConditional] = React.useState(question?.visibleWhenQuestionKey !== null);
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  return (
    <>
      <form
        className="flex flex-col gap-5"
        action={(form) => {
          setErrors({});
          startTransition(async () => {
            // Options come in as "value|Label" lines, which is the fastest way
            // to enter a dozen choices without a repeater widget.
            const options = text(form, 'options')
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
              .map((line) => {
                const [value, ...rest] = line.split('|');
                const label = rest.join('|').trim();
                return {
                  value: (value ?? '').trim(),
                  label: label.length > 0 ? label : (value ?? '').trim(),
                };
              });

            const result = await saveQuestionAction(
              {
                sectionId,
                key: text(form, 'key'),
                type,
                label: text(form, 'label'),
                helpText: text(form, 'helpText'),
                placeholder: text(form, 'placeholder'),
                required,
                sortOrder: question?.sortOrder ?? 999,
                minLength: number(form, 'minLength') ?? null,
                maxLength: number(form, 'maxLength') ?? null,
                minValue: number(form, 'minValue') ?? null,
                maxValue: number(form, 'maxValue') ?? null,
                staffOnly,
                visibleWhenQuestionKey: conditional ? text(form, 'visibleWhenQuestionKey') : null,
                visibleWhenOperator: conditional ? text(form, 'visibleWhenOperator') : null,
                visibleWhenValue: conditional ? text(form, 'visibleWhenValue') : null,
                allowedMimeTypes: textList(form, 'allowedMimeTypes'),
                options,
              },
              question?.id,
            );

            if (result.ok) {
              toast.success(question === null ? 'Question added' : 'Question saved');
              onDone();
              router.refresh();
              return;
            }
            setErrors(result.fieldErrors ?? {});
            if (result.fieldErrors === undefined) toast.error('Could not save', result.message);
          });
        }}
      >
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr_1fr]">
          <Field label="Question" htmlFor="label" required error={errors.label}>
            <Input name="label" defaultValue={question?.label ?? ''} maxLength={200} />
          </Field>
          <Field
            label="Key"
            htmlFor="key"
            required
            hint={question === null ? 'Lowercase, underscores.' : 'Cannot change once answered.'}
            error={errors.key}
          >
            <Input
              name="key"
              defaultValue={question?.key ?? ''}
              maxLength={48}
              className="font-mono"
            />
          </Field>
          <Field label="Type" htmlFor="type">
            <Select
              name="type"
              value={type}
              onChange={(event) => {
                setType(event.target.value);
              }}
            >
              {questionTypes.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Help text" htmlFor="helpText" error={errors.helpText}>
            <Input name="helpText" defaultValue={question?.helpText ?? ''} maxLength={500} />
          </Field>
          <Field label="Placeholder" htmlFor="placeholder" error={errors.placeholder}>
            <Input name="placeholder" defaultValue={question?.placeholder ?? ''} maxLength={120} />
          </Field>
        </div>

        {needsOptions.has(type) ? (
          <Field
            label="Options"
            htmlFor="options"
            required
            hint="One per line, as value|Label. The value is stored; the label is shown."
            error={errors.options}
          >
            <Textarea
              name="options"
              rows={5}
              className="font-mono text-xs"
              defaultValue={(question?.options ?? [])
                .map((option) => `${option.value}|${option.label}`)
                .join('\n')}
            />
          </Field>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-4">
          {type === 'NUMBER' ? (
            <>
              <Field label="Minimum" htmlFor="minValue">
                <Input
                  name="minValue"
                  type="number"
                  defaultValue={question?.minValue === null ? '' : String(question?.minValue ?? '')}
                />
              </Field>
              <Field label="Maximum" htmlFor="maxValue">
                <Input
                  name="maxValue"
                  type="number"
                  defaultValue={question?.maxValue === null ? '' : String(question?.maxValue ?? '')}
                />
              </Field>
            </>
          ) : (
            <>
              <Field
                label={needsOptions.has(type) ? 'Min choices' : 'Min length'}
                htmlFor="minLength"
                error={errors.minLength}
              >
                <Input
                  name="minLength"
                  type="number"
                  min={0}
                  defaultValue={
                    question?.minLength === null ? '' : String(question?.minLength ?? '')
                  }
                />
              </Field>
              <Field
                label={needsOptions.has(type) ? 'Max choices' : 'Max length'}
                htmlFor="maxLength"
              >
                <Input
                  name="maxLength"
                  type="number"
                  min={1}
                  defaultValue={
                    question?.maxLength === null ? '' : String(question?.maxLength ?? '')
                  }
                />
              </Field>
            </>
          )}

          <label className="flex items-center gap-3 pb-2.5 text-sm text-ink-secondary">
            <Switch checked={required} onCheckedChange={setRequired} label="Required" />
            Required
          </label>
          <label className="flex items-center gap-3 pb-2.5 text-sm text-ink-secondary">
            <Switch checked={staffOnly} onCheckedChange={setStaffOnly} label="Staff only" />
            Staff only
          </label>
        </div>

        <fieldset className="flex flex-col gap-4 rounded-md border border-line p-4">
          <label className="flex items-center gap-3 text-sm text-ink-secondary">
            <Switch
              checked={conditional}
              onCheckedChange={setConditional}
              label="Show conditionally"
            />
            Only show this when another answer matches
          </label>

          {conditional ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="When" htmlFor="visibleWhenQuestionKey">
                <Select
                  name="visibleWhenQuestionKey"
                  defaultValue={question?.visibleWhenQuestionKey ?? ''}
                >
                  <option value="">Choose a question…</option>
                  {otherQuestions.map((entry) => (
                    <option key={entry.key} value={entry.key}>
                      {entry.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Condition" htmlFor="visibleWhenOperator">
                <Select
                  name="visibleWhenOperator"
                  defaultValue={question?.visibleWhenOperator ?? 'EQUALS'}
                >
                  <option value="EQUALS">is exactly</option>
                  <option value="NOT_EQUALS">is not</option>
                  <option value="CONTAINS">contains</option>
                  <option value="IS_NOT_EMPTY">is answered</option>
                  <option value="IS_EMPTY">is not answered</option>
                </Select>
              </Field>
              <Field label="Value" htmlFor="visibleWhenValue" hint="For yes/no, use true or false.">
                <Input
                  name="visibleWhenValue"
                  defaultValue={question?.visibleWhenValue ?? ''}
                  maxLength={200}
                />
              </Field>
            </div>
          ) : null}
        </fieldset>

        <div className="flex items-center justify-between gap-3">
          {question === null ? (
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
          <div className="flex gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onDone}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" size="sm" loading={pending}>
              {question === null ? 'Add question' : 'Save'}
            </Button>
          </div>
        </div>
      </form>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this question?"
        description="Refused if applicants have already answered it - hide it with a condition instead, which keeps their answers."
        confirmLabel="Delete"
        tone="danger"
        loading={pending}
        onConfirm={() => {
          if (question === null) return;
          startTransition(async () => {
            const result = await deleteQuestionAction(question.id);
            if (result.ok) {
              toast.success('Question deleted');
              setConfirmDelete(false);
              onDone();
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

// --- Settings ----------------------------------------------------------------

function SettingsTab({
  template,
  departments,
  roles,
}: {
  template: BuilderTemplate;
  departments: readonly { id: string; name: string }[];
  roles: readonly { key: string; name: string }[];
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [flags, setFlags] = React.useState({
    requiresGuildMember: template.requiresGuildMember,
    requiresFivemLink: template.requiresFivemLink,
    requiresRulesAccepted: template.requiresRulesAccepted,
    requiresCharacter: template.requiresCharacter,
    interviewRequired: template.interviewRequired,
    allowResubmission: template.allowResubmission,
    autoAssignReviewer: template.autoAssignReviewer,
    grantsWhitelist: template.grantsWhitelist,
  });
  const [grantRoles, setGrantRoles] = React.useState<ReadonlySet<string>>(
    new Set(template.grantRoleKeys),
  );
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [pending, startTransition] = React.useTransition();

  const toggle = (key: keyof typeof flags) => (next: boolean) => {
    setFlags((current) => ({ ...current, [key]: next }));
  };

  return (
    <Panel tone="flat" pad="lg">
      <form
        className="flex flex-col gap-6"
        action={(form) => {
          setErrors({});
          startTransition(async () => {
            const result = await saveTemplateAction(
              {
                slug: text(form, 'slug'),
                name: text(form, 'name'),
                summary: text(form, 'summary'),
                description: text(form, 'description'),
                publicIdPrefix: text(form, 'publicIdPrefix'),
                departmentId: text(form, 'departmentId') || null,
                status: text(form, 'status'),
                opensAt: text(form, 'opensAt') || null,
                closesAt: text(form, 'closesAt') || null,
                minimumAccountAgeDays: number(form, 'minimumAccountAgeDays') ?? 0,
                rejectionCooldownDays: number(form, 'rejectionCooldownDays') ?? 14,
                maxConcurrent: number(form, 'maxConcurrent') ?? 1,
                expiryDays: number(form, 'expiryDays') ?? 0,
                reviewChannelId: text(form, 'reviewChannelId') || null,
                notifyRoleId: text(form, 'notifyRoleId') || null,
                sortOrder: number(form, 'sortOrder') ?? 0,
                requiredRoleKeys: [],
                blockedRoleKeys: [],
                grantRoleKeys: [...grantRoles],
                ...flags,
              },
              template.id,
            );

            if (result.ok) {
              toast.success('Settings saved');
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
            <Input name="name" defaultValue={template.name} maxLength={64} />
          </Field>
          <Field label="Slug" htmlFor="slug" required error={errors.slug}>
            <Input name="slug" defaultValue={template.slug} maxLength={64} />
          </Field>
          <Field label="ID prefix" htmlFor="publicIdPrefix" required error={errors.publicIdPrefix}>
            <Input
              name="publicIdPrefix"
              defaultValue={template.publicIdPrefix}
              maxLength={4}
              className="font-mono"
            />
          </Field>
        </div>

        <Field label="Summary" htmlFor="summary" error={errors.summary}>
          <Input name="summary" defaultValue={template.summary ?? ''} maxLength={160} />
        </Field>

        <Field label="Description" htmlFor="description" error={errors.description}>
          <Textarea
            name="description"
            defaultValue={template.description ?? ''}
            rows={3}
            maxLength={2000}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-4">
          <Field label="Status" htmlFor="status">
            <Select name="status" defaultValue={template.status}>
              <option value="DRAFT">Draft</option>
              <option value="OPEN">Open</option>
              <option value="CLOSED">Closed</option>
              <option value="ARCHIVED">Archived</option>
            </Select>
          </Field>
          <Field label="Department" htmlFor="departmentId">
            <Select name="departmentId" defaultValue={template.departmentId ?? ''}>
              <option value="">None</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Opens" htmlFor="opensAt">
            <Input name="opensAt" type="date" defaultValue={template.opensAt ?? ''} />
          </Field>
          <Field label="Closes" htmlFor="closesAt">
            <Input name="closesAt" type="date" defaultValue={template.closesAt ?? ''} />
          </Field>
        </div>

        <fieldset className="flex flex-col gap-3 rounded-md border border-line p-4">
          <legend className="x-eyebrow px-1">Requirements</legend>
          {(
            [
              ['requiresGuildMember', 'Must be in the Discord'],
              ['requiresRulesAccepted', 'Must have accepted the current rules'],
              ['requiresFivemLink', 'Must have linked FiveM'],
              ['requiresCharacter', 'Must have a character'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-center gap-3 text-sm text-ink-secondary">
              <Switch checked={flags[key]} onCheckedChange={toggle(key)} label={label} />
              {label}
            </label>
          ))}

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Minimum account age" htmlFor="minimumAccountAgeDays" hint="Days.">
              <Input
                name="minimumAccountAgeDays"
                type="number"
                min={0}
                defaultValue={String(template.minimumAccountAgeDays)}
              />
            </Field>
            <Field label="Cooldown after rejection" htmlFor="rejectionCooldownDays" hint="Days.">
              <Input
                name="rejectionCooldownDays"
                type="number"
                min={0}
                defaultValue={String(template.rejectionCooldownDays)}
              />
            </Field>
            <Field label="Concurrent applications" htmlFor="maxConcurrent">
              <Input
                name="maxConcurrent"
                type="number"
                min={1}
                defaultValue={String(template.maxConcurrent)}
              />
            </Field>
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-3 rounded-md border border-line p-4">
          <legend className="x-eyebrow px-1">Workflow</legend>
          {(
            [
              ['interviewRequired', 'Interview stage'],
              ['allowResubmission', 'Allow resubmission after changes'],
              ['autoAssignReviewer', 'Auto-assign a reviewer'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-center gap-3 text-sm text-ink-secondary">
              <Switch checked={flags[key]} onCheckedChange={toggle(key)} label={label} />
              {label}
            </label>
          ))}

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Expire drafts after" htmlFor="expiryDays" hint="Days. 0 disables expiry.">
              <Input
                name="expiryDays"
                type="number"
                min={0}
                defaultValue={String(template.expiryDays)}
              />
            </Field>
            <Field
              label="Review channel"
              htmlFor="reviewChannelId"
              hint="Overrides the guild default."
            >
              <Input
                name="reviewChannelId"
                defaultValue={template.reviewChannelId ?? ''}
                maxLength={20}
                className="font-mono"
              />
            </Field>
            <Field label="Ping role" htmlFor="notifyRoleId">
              <Input
                name="notifyRoleId"
                defaultValue={template.notifyRoleId ?? ''}
                maxLength={20}
                className="font-mono"
              />
            </Field>
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-3 rounded-md border border-xenon/25 p-4">
          <legend className="x-eyebrow px-1 text-xenon">What approval grants</legend>

          <label className="flex items-center gap-3 text-sm text-ink-secondary">
            <Switch
              checked={flags.grantsWhitelist}
              onCheckedChange={toggle('grantsWhitelist')}
              label="Grants whitelist"
            />
            Grant whitelist access
          </label>

          <div className="flex flex-wrap gap-2">
            {roles.map((role) => (
              <Choice
                key={role.key}
                type="checkbox"
                label={role.name}
                className="w-auto"
                checked={grantRoles.has(role.key)}
                onChange={() => {
                  setGrantRoles((current) => {
                    const next = new Set(current);
                    if (next.has(role.key)) next.delete(role.key);
                    else next.add(role.key);
                    return next;
                  });
                }}
              />
            ))}
          </div>
        </fieldset>

        <div className="flex items-center justify-between gap-3">
          <Field label="Order" htmlFor="sortOrder" className="max-w-24">
            <Input
              name="sortOrder"
              type="number"
              min={0}
              defaultValue={String(template.sortOrder)}
            />
          </Field>
          <Button type="submit" variant="accent" loading={pending}>
            Save settings
          </Button>
        </div>
      </form>
    </Panel>
  );
}

// --- Preview -----------------------------------------------------------------

function PreviewTab({ sections }: { sections: readonly BuilderSection[] }): React.ReactElement {
  // Local-only answers: the preview exercises conditional visibility without
  // creating a submission.
  const [values, setValues] = React.useState<Record<string, AnswerValue | undefined>>({});

  const questions = sections.flatMap((section) =>
    section.questions.map((question) => ({
      ...question,
      allowedMimeTypes: [] as string[],
      maxFiles: null,
      maxFileSizeBytes: null,
      pattern: null,
    })),
  );

  const visible = (question: BuilderQuestion): boolean => {
    if (question.visibleWhenQuestionKey === null || question.visibleWhenOperator === null) {
      return true;
    }

    const source = values[question.visibleWhenQuestionKey] ?? {};
    const actual =
      source.textValue ??
      (source.booleanValue === undefined || source.booleanValue === null
        ? (source.choiceValues ?? []).join(',')
        : String(source.booleanValue));
    const expected = question.visibleWhenValue ?? '';

    switch (question.visibleWhenOperator) {
      case 'EQUALS':
        return actual === expected;
      case 'NOT_EQUALS':
        return actual !== expected;
      case 'CONTAINS':
        return actual.includes(expected);
      case 'IS_EMPTY':
        return actual.length === 0;
      case 'IS_NOT_EMPTY':
        return actual.length > 0;
      default:
        return true;
    }
  };

  return (
    <Panel tone="flat" pad="lg" className="flex flex-col gap-8">
      <p className="text-xs text-ink-muted">
        This is exactly what an applicant sees, rendered through the same component the real form
        uses. Answer a controlling question to watch its conditional questions appear. Nothing here
        is saved.
      </p>

      {sections.map((section) => (
        <section key={section.id} className="flex flex-col gap-5">
          <div className="border-b border-line pb-2">
            <h3 className="font-display text-base font-bold text-ink">{section.title}</h3>
            {section.description === null ? null : (
              <p className="mt-1 text-xs text-ink-muted">{section.description}</p>
            )}
          </div>

          {section.questions
            .filter((question) => !question.staffOnly && visible(question))
            .map((question) => {
              const definition = questions.find((entry) => entry.id === question.id);
              if (definition === undefined) return null;

              return (
                <QuestionField
                  key={question.id}
                  question={{
                    id: definition.id,
                    key: definition.key,
                    // The builder stores these as plain strings; the shared
                    // renderer wants the narrowed union.
                    type: definition.type as never,
                    label: definition.label,
                    helpText: definition.helpText,
                    placeholder: definition.placeholder,
                    required: definition.required,
                    minLength: definition.minLength,
                    maxLength: definition.maxLength,
                    minValue: definition.minValue,
                    maxValue: definition.maxValue,
                    pattern: null,
                    staffOnly: definition.staffOnly,
                    visibleWhenQuestionKey: definition.visibleWhenQuestionKey,
                    visibleWhenOperator: definition.visibleWhenOperator as never,
                    visibleWhenValue: definition.visibleWhenValue,
                    maxFiles: null,
                    maxFileSizeBytes: null,
                    allowedMimeTypes: [],
                    options: definition.options,
                  }}
                  value={values[question.key]}
                  errors={undefined}
                  disabled={false}
                  characters={[{ id: 'preview', label: 'A character (preview)' }]}
                  onChange={(next) => {
                    setValues((current) => ({ ...current, [question.key]: next }));
                  }}
                />
              );
            })}
        </section>
      ))}
    </Panel>
  );
}
