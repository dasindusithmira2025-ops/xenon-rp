'use client';

import * as React from 'react';

import type { SupportSettings } from '@xenon/discord';
import { Button, Input, Panel, Switch, useToast } from '@xenon/ui';

import { saveSupportSettingsAction } from '~/app/(control)/control/discord/actions';

/** Discord support mirrors a private Xenon portal workflow without owning ticket data. */
export function DiscordSupportSettings({
  settings,
  supportChannelId,
}: {
  settings: SupportSettings;
  supportChannelId: string | null;
}): React.ReactElement {
  const toast = useToast();
  const [value, setValue] = React.useState(settings);
  const [pending, startTransition] = React.useTransition();

  return (
    <Panel tone="flat" pad="lg">
      <form
        className="flex flex-col gap-5"
        action={() => {
          startTransition(async () => {
            const result = await saveSupportSettingsAction(value);
            if (result.ok) toast.success('Support settings saved');
            else toast.error('Could not save support settings', result.message);
          });
        }}
      >
        <div>
          <h2 className="x-eyebrow">Support center</h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-muted">
            Discord is an entry point and private notification surface. Xenon stores the ticket,
            replies, permissions and history in its portal.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Switch
            checked={value.dmNotifications}
            onCheckedChange={(next) => {
              setValue((current) => ({ ...current, dmNotifications: next }));
            }}
            label="Send ticket panels by private DM"
          />
          <Switch
            checked={value.allowDiscordClose}
            onCheckedChange={(next) => {
              setValue((current) => ({ ...current, allowDiscordClose: next }));
            }}
            label="Allow the owner to close from Discord"
          />
        </div>

        <label className="flex flex-col gap-2 text-xs font-medium text-ink-muted">
          Managed support panel channel
          <Input
            value={supportChannelId ?? 'Run /xenon setup apply to provision #support'}
            readOnly
          />
        </label>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-md border border-line p-4">
            <p className="x-eyebrow">Category routes</p>
            <ul className="mt-3 flex flex-col gap-2 text-xs leading-relaxed text-ink-secondary">
              <li>General · Technical · Character · Whitelist · Business → Xenon ticket form</li>
              <li>Player report · Staff report → protected report form</li>
              <li>Developer issue → staff ticket queue, capability checked in Xenon</li>
            </ul>
          </div>
          <div className="rounded-md border border-line p-4">
            <p className="x-eyebrow">Privacy and authority</p>
            <ul className="mt-3 flex flex-col gap-2 text-xs leading-relaxed text-ink-secondary">
              <li>Ticket notifications go only to the linked ticket owner by DM.</li>
              <li>
                Discord roles never grant support capabilities; Xenon RBAC checks tickets.view,
                tickets.reply and tickets.manage.
              </li>
              <li>
                Close actions update the canonical Xenon ticket. Replies and retention stay in the
                portal; no public thread is created.
              </li>
            </ul>
          </div>
        </div>

        <div className="flex justify-end">
          <Button type="submit" variant="accent" size="sm" loading={pending}>
            Save support settings
          </Button>
        </div>
      </form>
    </Panel>
  );
}
