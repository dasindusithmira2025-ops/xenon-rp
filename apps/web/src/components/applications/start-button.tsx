'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Button, useToast } from '@xenon/ui';

import { startApplicationAction } from '~/app/(site)/applications/actions';

/**
 * Starts a draft and navigates into it.
 *
 * A client component because the outcome is two different things - a
 * navigation or an error toast - and a plain form post would have to pick one.
 * The server action is still the authority: `disabled` here is presentation,
 * and the action re-checks eligibility regardless of what the button allowed.
 */
export function StartApplicationButton({
  slug,
  disabled,
  availableAt,
}: {
  slug: string;
  disabled: boolean;
  availableAt: string | null;
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = React.useTransition();

  if (availableAt !== null) {
    return (
      <Button variant="outline" disabled className="w-full">
        Available from {new Date(availableAt).toLocaleDateString('en-GB')}
      </Button>
    );
  }

  return (
    <Button
      variant="accent"
      className="w-full"
      loading={pending}
      disabled={disabled}
      onClick={() => {
        startTransition(async () => {
          const result = await startApplicationAction(slug);
          if (result.ok) {
            router.push(`/portal/applications/${result.data.publicId}`);
            return;
          }
          toast.error('Could not start this application', result.message);
        });
      }}
    >
      {disabled ? 'Requirements not met' : 'Start application'}
    </Button>
  );
}
