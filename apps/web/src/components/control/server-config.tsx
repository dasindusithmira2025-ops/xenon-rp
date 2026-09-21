'use client';

import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Badge, Button, Field, Input, Panel, Select, StatusDot, Switch, useToast } from '@xenon/ui';

import { upsertServerAction } from '~/app/(control)/control/actions';
import { number, text } from '~/lib/form';

export interface ServerRecord {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly adapter: string;
  readonly connectUrl: string | null;
  readonly endpointUrl: string | null;
  readonly maxPlayers: number | null;
  readonly restartCron: string | null;
  readonly timezone: string;
  readonly isPublic: boolean;
  readonly sortOrder: number;
  readonly state: string;
}

// Open record: `state` arrives as a plain string from the server component, so
// the lookup genuinely can miss and the fallback is not dead code.
const dotState: Record<string, 'online' | 'offline' | 'degraded' | 'unknown'> = {
  ONLINE: 'online',
  OFFLINE: 'offline',
  DEGRADED: 'degraded',
  UNKNOWN: 'unknown',
};

export function ServerConfig({
  servers,
}: {
  servers: readonly ServerRecord[];
}): React.ReactElement {
  const [creating, setCreating] = React.useState(false);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="x-eyebrow">Servers</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setCreating((current) => !current);
          }}
        >
          <Plus /> Add a server
        </Button>
      </div>

      {creating ? (
        <ServerForm
          server={null}
          onDone={() => {
            setCreating(false);
          }}
        />
      ) : null}

      {servers.map((server) => (
        <ServerForm key={server.id} server={server} />
      ))}
    </div>
  );
}

function ServerForm({
  server,
  onDone,
}: {
  server: ServerRecord | null;
  onDone?: () => void;
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [isPublic, setIsPublic] = React.useState(server?.isPublic ?? true);
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [pending, startTransition] = React.useTransition();

  return (
    <Panel tone="flat" pad="lg">
      <form
        className="flex flex-col gap-5"
        action={(form) => {
          setErrors({});
          startTransition(async () => {
            const result = await upsertServerAction(
              {
                slug: text(form, 'slug'),
                name: text(form, 'name'),
                adapter: text(form, 'adapter'),
                connectUrl: text(form, 'connectUrl'),
                endpointUrl: text(form, 'endpointUrl') || null,
                maxPlayers: number(form, 'maxPlayers') ?? null,
                restartCron: text(form, 'restartCron'),
                timezone: text(form, 'timezone') || 'Asia/Colombo',
                isPublic,
                sortOrder: number(form, 'sortOrder') ?? 0,
              },
              server?.id,
            );

            if (result.ok) {
              toast.success(server === null ? 'Server added' : 'Server updated');
              onDone?.();
              router.refresh();
              return;
            }
            setErrors(result.fieldErrors ?? {});
            if (result.fieldErrors === undefined) toast.error('Could not save', result.message);
          });
        }}
      >
        {server === null ? null : (
          <div className="flex items-center gap-3">
            <StatusDot state={dotState[server.state] ?? 'unknown'} />
            <span className="font-display text-sm font-bold text-ink">{server.name}</span>
            <Badge tone={server.adapter === 'MOCK' ? 'warning' : 'chrome'}>{server.adapter}</Badge>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="name" required error={errors.name}>
            <Input name="name" defaultValue={server?.name ?? ''} maxLength={64} />
          </Field>
          <Field label="Slug" htmlFor="slug" required error={errors.slug}>
            <Input name="slug" defaultValue={server?.slug ?? ''} maxLength={64} />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Framework"
            htmlFor="adapter"
            hint="Tells the bridge what to do locally. Xenon's behaviour does not change."
          >
            <Select name="adapter" defaultValue={server?.adapter ?? 'MOCK'}>
              <option value="MOCK">Mock (development, no server)</option>
              <option value="STANDALONE">Standalone</option>
              <option value="QBCORE">QBCore</option>
              <option value="QBX">QBX</option>
              <option value="ESX">ESX</option>
            </Select>
          </Field>
          <Field
            label="Bridge endpoint"
            htmlFor="endpointUrl"
            hint="Internal URL of xenon_bridge, e.g. http://127.0.0.1:30120"
            error={errors.endpointUrl}
          >
            <Input name="endpointUrl" defaultValue={server?.endpointUrl ?? ''} />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Connect link" htmlFor="connectUrl" hint="Shown publicly.">
            <Input name="connectUrl" defaultValue={server?.connectUrl ?? ''} maxLength={200} />
          </Field>
          <Field label="Max players" htmlFor="maxPlayers" error={errors.maxPlayers}>
            <Input
              name="maxPlayers"
              type="number"
              min={1}
              max={2048}
              defaultValue={server?.maxPlayers === null ? '' : String(server?.maxPlayers ?? '')}
            />
          </Field>
          <Field
            label="Restart schedule"
            htmlFor="restartCron"
            hint="Minute and hour, e.g. 0 4,10,16,22 * * *"
          >
            <Input
              name="restartCron"
              defaultValue={server?.restartCron ?? ''}
              className="font-mono"
              maxLength={64}
            />
          </Field>
        </div>

        <div className="grid items-end gap-4 sm:grid-cols-3">
          <Field label="Timezone" htmlFor="timezone">
            <Input
              name="timezone"
              defaultValue={server?.timezone ?? 'Asia/Colombo'}
              maxLength={64}
            />
          </Field>
          <Field label="Order" htmlFor="sortOrder">
            <Input
              name="sortOrder"
              type="number"
              min={0}
              defaultValue={String(server?.sortOrder ?? 0)}
            />
          </Field>
          <label className="flex items-center gap-3 pb-2.5 text-sm text-ink-secondary">
            <Switch checked={isPublic} onCheckedChange={setIsPublic} label="Show publicly" />
            Show on the status page
          </label>
        </div>

        <div className="flex justify-end">
          <Button type="submit" variant="accent" size="sm" loading={pending}>
            {server === null ? 'Add server' : 'Save'}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
