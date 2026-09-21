'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Button, Field, Input, Textarea, useToast } from '@xenon/ui';

import { updateProfileAction } from '~/app/(portal)/portal/actions';
import { text } from '~/lib/form';

/**
 * Profile editing.
 *
 * Uncontrolled inputs with `FormData` on submit. A profile is four short fields
 * that get changed once a year - controlled state and autosave would be
 * machinery for a problem this form does not have.
 */
export function ProfileForm({
  initial,
}: {
  initial: { displayName: string; pronouns: string; timezone: string; bio: string };
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [pending, startTransition] = React.useTransition();

  // React 19 form actions: no submit event, no preventDefault, and the browser
  // still does the right thing when JavaScript has not loaded yet.
  const submit = (form: FormData): void => {
    setErrors({});
    startTransition(async () => {
      const result = await updateProfileAction({
        displayName: text(form, 'displayName'),
        pronouns: text(form, 'pronouns'),
        timezone: text(form, 'timezone'),
        bio: text(form, 'bio'),
      });

      if (result.ok) {
        toast.success('Profile saved');
        router.refresh();
        return;
      }

      setErrors(result.fieldErrors ?? {});
      if (result.fieldErrors === undefined) toast.error('Could not save', result.message);
    });
  };

  return (
    <form action={submit} className="flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Display name" htmlFor="displayName" required error={errors.displayName}>
          <Input name="displayName" defaultValue={initial.displayName} maxLength={32} />
        </Field>
        <Field
          label="Pronouns"
          htmlFor="pronouns"
          hint="Optional. Shown to staff and on your profile."
          error={errors.pronouns}
        >
          <Input name="pronouns" defaultValue={initial.pronouns} maxLength={24} />
        </Field>
      </div>

      <Field
        label="Timezone"
        htmlFor="timezone"
        hint="Helps staff schedule interviews at a sane hour for you."
        error={errors.timezone}
      >
        <Input
          name="timezone"
          defaultValue={initial.timezone}
          placeholder="Asia/Colombo"
          maxLength={64}
        />
      </Field>

      <Field label="About you" htmlFor="bio" error={errors.bio}>
        <Textarea name="bio" defaultValue={initial.bio} rows={4} maxLength={400} />
      </Field>

      <div className="flex justify-end">
        <Button type="submit" variant="accent" loading={pending}>
          Save profile
        </Button>
      </div>
    </form>
  );
}
