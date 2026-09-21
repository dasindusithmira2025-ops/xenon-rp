'use client';

import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Input,
  Select,
  Textarea,
  useToast,
} from '@xenon/ui';

import { saveTemplateAction } from '~/app/(control)/control/applications/templates/actions';
import { text } from '~/lib/form';

/**
 * Create a template.
 *
 * Only the fields needed to exist. Everything else - requirements, cooldowns,
 * what it grants - is configured in the builder afterwards, where there is room
 * to explain what each one does.
 */
export function NewTemplateButton({
  departments,
}: {
  departments: readonly { id: string; name: string }[];
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [pending, startTransition] = React.useTransition();

  return (
    <>
      <Button
        variant="accent"
        size="sm"
        onClick={() => {
          setOpen(true);
        }}
      >
        <Plus /> New application type
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader
            title="New application type"
            description="It starts as a draft. Add sections and questions before opening it."
          />

          <form
            className="flex flex-col gap-5"
            action={(form) => {
              setErrors({});
              startTransition(async () => {
                const result = await saveTemplateAction({
                  slug: text(form, 'slug'),
                  name: text(form, 'name'),
                  summary: text(form, 'summary'),
                  publicIdPrefix: text(form, 'publicIdPrefix'),
                  departmentId: text(form, 'departmentId') || null,
                  status: 'DRAFT',
                });

                if (result.ok) {
                  toast.success('Created', 'Now add sections and questions.');
                  setOpen(false);
                  router.push(`/control/applications/templates/${result.data.slug}`);
                  return;
                }
                setErrors(result.fieldErrors ?? {});
                if (result.fieldErrors === undefined) {
                  toast.error('Could not create', result.message);
                }
              });
            }}
          >
            <Field label="Name" htmlFor="name" required error={errors.name}>
              <Input name="name" placeholder="General Whitelist" maxLength={64} />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Slug" htmlFor="slug" required error={errors.slug}>
                <Input name="slug" placeholder="whitelist" maxLength={64} />
              </Field>
              <Field
                label="ID prefix"
                htmlFor="publicIdPrefix"
                required
                hint="Two to four letters. Submissions become XN-WL-1842."
                error={errors.publicIdPrefix}
              >
                <Input name="publicIdPrefix" placeholder="WL" maxLength={4} className="font-mono" />
              </Field>
            </div>

            <Field label="Summary" htmlFor="summary" error={errors.summary}>
              <Textarea name="summary" rows={2} maxLength={160} />
            </Field>

            <Field
              label="Department"
              htmlFor="departmentId"
              hint="Optional. Links it to a department page."
            >
              <Select name="departmentId" defaultValue="">
                <option value="">None</option>
                {departments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name}
                  </option>
                ))}
              </Select>
            </Field>

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setOpen(false);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" variant="accent" loading={pending}>
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
