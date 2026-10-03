'use client';

import { Megaphone } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import type { AnnouncementType } from '@xenon/discord';
import { Button, Field, Input, Panel, Select, Switch, Textarea, useToast } from '@xenon/ui';

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
  channels,
  notificationRoles,
}: {
  defaultChannelId: string | null;
  discordConfigured: boolean;
  channels: readonly { id: string; label: string }[];
  notificationRoles: readonly { id: string; label: string }[];
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [toWebsite, setToWebsite] = React.useState(true);
  const [toDiscord, setToDiscord] = React.useState(discordConfigured && defaultChannelId !== null);
  const [type, setType] = React.useState<AnnouncementType>('COMMUNITY');
  const [title, setTitle] = React.useState('');
  const [body, setBody] = React.useState('');
  const [targetChannelId, setTargetChannelId] = React.useState(
    defaultChannelId ?? channels[0]?.id ?? '',
  );
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
              type,
              toWebsite,
              toDiscord,
              discordChannelId: toDiscord ? targetChannelId || null : null,
              discordNotifyRoleId: toDiscord ? text(form, 'discordNotifyRoleId') || null : null,
              scheduledAt: text(form, 'scheduledAt')
                ? new Date(text(form, 'scheduledAt')).toISOString()
                : null,
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
          <Input
            id="title"
            name="title"
            maxLength={140}
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
        </Field>

        <Field label="Announcement type" htmlFor="announcement-type">
          <Select
            id="announcement-type"
            value={type}
            onChange={(event) => {
              setType(event.target.value as AnnouncementType);
            }}
          >
            <option value="SERVER">Server announcement</option>
            <option value="MAINTENANCE">Maintenance</option>
            <option value="RESTART">Server restart</option>
            <option value="UPDATE">City update</option>
            <option value="PATCH_NOTES">Patch notes</option>
            <option value="EVENT">Community event</option>
            <option value="RECRUITMENT">Recruitment</option>
            <option value="EMERGENCY">Emergency notice</option>
            <option value="COMMUNITY">Community announcement</option>
          </Select>
        </Field>

        <Field
          label="Message"
          htmlFor="body"
          required
          hint="Plain text. Line breaks are preserved."
          error={errors.body}
        >
          <Textarea
            name="body"
            rows={6}
            maxLength={4000}
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
            }}
          />
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
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Target channel"
              htmlFor="discordChannelId"
              error={errors.discordChannelId}
            >
              <Select
                id="discordChannelId"
                value={targetChannelId}
                onChange={(event) => {
                  setTargetChannelId(event.target.value);
                }}
                disabled={channels.length === 0}
              >
                {channels.length === 0 ? <option value="">No managed channels</option> : null}
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {channel.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Optional notification role" htmlFor="discordNotifyRoleId">
              <Select id="discordNotifyRoleId" name="discordNotifyRoleId" defaultValue="">
                <option value="">No role mention</option>
                {notificationRoles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        ) : null}

        <Field
          label="Schedule"
          htmlFor="scheduledAt"
          hint="Leave empty to publish now. Uses your local time."
        >
          <Input id="scheduledAt" name="scheduledAt" type="datetime-local" />
        </Field>

        <AnnouncementPreview type={type} title={title} body={body} />

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

function AnnouncementPreview({
  type,
  title,
  body,
}: {
  type: AnnouncementType;
  title: string;
  body: string;
}): React.ReactElement {
  const label: Record<AnnouncementType, string> = {
    SERVER: 'SERVER ANNOUNCEMENT',
    MAINTENANCE: 'SCHEDULED MAINTENANCE',
    RESTART: 'SERVER RESTART',
    UPDATE: 'CITY UPDATE',
    PATCH_NOTES: 'PATCH NOTES',
    EVENT: 'COMMUNITY EVENT',
    RECRUITMENT: 'RECRUITMENT',
    EMERGENCY: 'EMERGENCY NOTICE',
    COMMUNITY: 'COMMUNITY ANNOUNCEMENT',
  };
  const color =
    type === 'EMERGENCY'
      ? '#ff4d4d'
      : type === 'MAINTENANCE' || type === 'RESTART'
        ? '#ffb020'
        : '#2AFD23';
  return (
    <div
      className="rounded-lg border border-line bg-[#090c09] p-5"
      aria-label="Discord announcement preview"
    >
      <p className="text-[0.65rem] font-semibold tracking-[0.18em] text-ink-muted">
        XENON ROLEPLAY
      </p>
      <p className="mt-3 text-[0.65rem] font-bold tracking-[0.14em]" style={{ color }}>
        {label[type]}
      </p>
      <h3 className="mt-2 text-base font-bold text-white">{title || 'Announcement title'}</h3>
      <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-ink-secondary">
        {body || 'Your message will appear here with the same spacing used in Discord.'}
      </p>
      <div className="mt-5 flex items-center justify-between border-t border-line pt-3 text-[0.65rem] text-ink-muted">
        <span>XenonRP • Announcements</span>
        <span>Now</span>
      </div>
    </div>
  );
}
