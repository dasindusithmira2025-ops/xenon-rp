'use client';

import * as React from 'react';

import type { WelcomeSettings } from '@xenon/discord';
import { Button, Field, Input, Panel, Select, Switch, useToast } from '@xenon/ui';

import { saveWelcomeSettingsAction } from '~/app/(control)/control/discord/actions';

/** Join behavior. Member intent is requested by the bot only while a join feature is enabled. */
export function DiscordWelcomeSettings({
  settings,
  defaultChannelId,
}: {
  settings: WelcomeSettings;
  defaultChannelId: string | null;
}): React.ReactElement {
  const toast = useToast();
  const [value, setValue] = React.useState<WelcomeSettings>({
    ...settings,
    channelId: settings.channelId ?? defaultChannelId,
  });
  const [pending, startTransition] = React.useTransition();
  const [channelError, setChannelError] = React.useState<string | undefined>();

  const update = <K extends keyof WelcomeSettings>(key: K, next: WelcomeSettings[K]): void => {
    setValue((current) => ({ ...current, [key]: next }));
  };

  return (
    <Panel tone="flat" pad="lg">
      <form
        className="flex flex-col gap-5"
        action={() => {
          setChannelError(undefined);
          startTransition(async () => {
            const result = await saveWelcomeSettingsAction(value);
            if (result.ok) {
              toast.success(
                'Welcome settings saved',
                'The bot will apply them on its next join event.',
              );
              return;
            }
            const fieldMessage = result.fieldErrors?.channelId?.[0];
            if (fieldMessage !== undefined) setChannelError(fieldMessage);
            else toast.error('Could not save welcome settings', result.message);
          });
        }}
      >
        <div>
          <h2 className="x-eyebrow">Automatic welcome</h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-muted">
            Public welcomes stay short. Account ID and whitelist details are sent only in a private
            DM when personalization is enabled.
          </p>
        </div>

        <Switch
          checked={value.enabled}
          onCheckedChange={(next) => {
            update('enabled', next);
          }}
          label="Enable join welcome features"
        />

        <Field label="Welcome channel ID" htmlFor="welcome-channel" error={channelError}>
          <Input
            id="welcome-channel"
            inputMode="numeric"
            value={value.channelId ?? ''}
            onChange={(event) => {
              update('channelId', event.target.value.trim() || null);
            }}
            placeholder={defaultChannelId ?? 'Discord channel snowflake'}
            maxLength={20}
            className="font-mono"
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Switch
            checked={value.publicEnabled}
            onCheckedChange={(next) => {
              update('publicEnabled', next);
            }}
            label="Post a public welcome"
          />
          <Switch
            checked={value.dmEnabled}
            onCheckedChange={(next) => {
              update('dmEnabled', next);
            }}
            label="Send a welcome DM"
          />
        </div>

        <Field
          label="Initial role"
          htmlFor="welcome-role"
          hint="Only the safe Citizen role can be assigned automatically."
        >
          <Select
            id="welcome-role"
            value={value.initialRoleKey ?? 'none'}
            onChange={(event) => {
              update('initialRoleKey', event.target.value === 'none' ? null : 'role.citizen');
            }}
          >
            <option value="none">No initial role</option>
            <option value="role.citizen">Citizen</option>
          </Select>
        </Field>

        <Field
          label="Delete public welcome after"
          htmlFor="welcome-delete"
          hint="Set to 0 to keep messages permanently."
        >
          <Input
            id="welcome-delete"
            type="number"
            min={0}
            max={604800}
            step={1}
            value={value.deleteAfterSeconds}
            onChange={(event) => {
              update('deleteAfterSeconds', Number(event.target.value));
            }}
          />
        </Field>

        <Switch
          checked={value.personalized}
          onCheckedChange={(next) => {
            update('personalized', next);
          }}
          label="Include linked Xenon details in the private DM"
        />

        <p className="text-xs leading-relaxed text-ink-muted">
          When public or DM welcomes are enabled, also enable <strong>Server Members Intent</strong>{' '}
          in the Discord Developer Portal. Xenon never requests Message Content.
        </p>

        <div className="flex justify-end">
          <Button type="submit" variant="accent" size="sm" loading={pending}>
            Save welcome settings
          </Button>
        </div>
      </form>
    </Panel>
  );
}
