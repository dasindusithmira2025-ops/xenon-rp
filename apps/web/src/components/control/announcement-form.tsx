'use client';

import { Megaphone } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Button, Field, Input, Panel, Switch, Textarea, useToast } from '@xenon/ui';

import { createAnnouncementAction } from '~/app/(control)/control/actions';
import { text } from '~/lib/form';

/**
 * Announcements.
 *
 * The website copy is written synchronously; Discord delivery is a queued job.
 * A rate limit or an offline guild delays the crosspost rather than losing the
 * announcement, and the operator is told that explicitly rather than being left
 * to wonder whether it went out.
 */
export function AnnouncementForm({
  defaultChannelId,
  discordConfigured,
}: {
  defaultChannelId: string | null;
  discordConfigured: boolean;
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [toWebsite, setToWebsite] = React.useState(true);
  const [toDiscord, setToDiscord] = React.useState(discordConfigured && defaultChannelId !== null);
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [pending, startTransition] = React.useTransition();

  if (!open) {
    return (
      <div className="flex justify-end">
        <Button
          variant="accent"
          size="sm"
          onClick={() => {
            setOpen(true);
          }}
        >
          <Megaphone /> New announcement
        </Button>
      </div>
    );
  }

  return (
    <Panel tone="raised" pad="lg" edgeLight>
      <form
        className="flex flex-col gap-5"
        action={(form) => {
          setErrors({});
          startTransition(async () => {
            const result = await createAnnouncementAction({
              title: text(form, 'title'),
              body: text(form, 'body'),
              toWebsite,
              toDiscord,
              discordChannelId: toDiscord ? text(form, 'discordChannelId') : null,
            });

            if (result.ok) {
              toast.success(
                'Announcement created',
                toDiscord ? 'Discord delivery has been queued.' : undefined,
              );
              setOpen(false);
              router.refresh();
              return;
            }
            setErrors(result.fieldErrors ?? {});
            if (result.fieldErrors === undefined) toast.error('Could not publish', result.message);
          });
        }}
      >
        <h2 className="x-eyebrow">New announcement</h2>

        <Field label="Title" htmlFor="title" required error={errors.title}>
          <Input name="title" maxLength={140} />
        </Field>

        <Field
          label="Message"
          htmlFor="body"
          required
          hint="Plain text. Line breaks are preserved."
          error={errors.body}
        >
          <Textarea name="body" rows={6} maxLength={4000} />
        </Field>

        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-3 text-sm text-ink-secondary">
            <Switch
              checked={toWebsite}
              onCheckedChange={setToWebsite}
              label="Post to the website"
            />
            Publish as a news article
          </label>

          <label className="flex items-center gap-3 text-sm text-ink-secondary">
            <Switch
              checked={toDiscord}
              onCheckedChange={setToDiscord}
              disabled={!discordConfigured}
              label="Post to Discord"
            />
            Post to Discord {discordConfigured ? '' : '(no guild configured)'}
          </label>
        </div>

        {toDiscord ? (
          <Field
            label="Channel"
            htmlFor="discordChannelId"
            hint="Defaults to the announcement channel configured under Integrations."
            error={errors.discordChannelId}
          >
            <Input
              name="discordChannelId"
              defaultValue={defaultChannelId ?? ''}
              maxLength={20}
              className="font-mono"
            />
          </Field>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setOpen(false);
            }}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="accent"
            size="sm"
            loading={pending}
            disabled={!toWebsite && !toDiscord}
          >
            Publish
          </Button>
        </div>
      </form>
    </Panel>
  );
}
