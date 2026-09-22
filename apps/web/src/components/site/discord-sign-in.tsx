'use client';

import { useFormStatus } from 'react-dom';

import { Button } from '@xenon/ui';
import { LoadingRail } from '@xenon/ui/motion';

export function DiscordSignIn({
  action,
  callbackUrl,
}: {
  action: (formData: FormData) => Promise<void>;
  callbackUrl: string;
}): React.ReactElement {
  return (
    <form action={action} className="relative flex flex-col gap-3">
      <input type="hidden" name="callbackUrl" value={callbackUrl} />
      <SubmitButton />
    </form>
  );
}

function SubmitButton(): React.ReactElement {
  const { pending } = useFormStatus();

  return (
    <>
      {pending ? <LoadingRail label="Connecting to Discord" /> : null}
      <Button
        type="submit"
        variant="accent"
        size="xl"
        className="w-full"
        disabled={pending}
        loading={pending}
        aria-live="polite"
      >
        {pending ? 'Connecting to Discord…' : 'Continue with Discord'}
      </Button>
    </>
  );
}
