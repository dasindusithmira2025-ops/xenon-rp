'use client';

import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Badge, Button, Choice, Field, Input, Panel, Switch, useToast } from '@xenon/ui';

import { upsertFeatureFlagAction } from '~/app/(control)/control/actions';
import { text } from '~/lib/form';

export interface FlagRecord {
  readonly key: string;
  readonly description: string | null;
  readonly enabled: boolean;
  readonly rollout: number;
  readonly forceForRoleKeys: readonly string[];
  readonly updatedAt: string;
}

/** Create and edit feature flags. */
export function FeatureFlagEditor({
  flags,
  roles,
}: {
  flags: readonly FlagRecord[];
  roles: readonly { key: string; name: string }[];
}): React.ReactElement {
  const [creating, setCreating] = React.useState(false);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setCreating((current) => !current);
          }}
        >
          <Plus /> New flag
        </Button>
      </div>

      {creating ? (
        <FlagForm
          roles={roles}
          flag={null}
          onDone={() => {
            setCreating(false);
          }}
        />
      ) : null}

      {flags.map((flag) => (
        <FlagForm key={flag.key} roles={roles} flag={flag} />
      ))}
    </div>
  );
}

function FlagForm({
  flag,
  roles,
  onDone,
}: {
  flag: FlagRecord | null;
  roles: readonly { key: string; name: string }[];
  onDone?: () => void;
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [enabled, setEnabled] = React.useState(flag?.enabled ?? false);
  const [forced, setForced] = React.useState<ReadonlySet<string>>(
    new Set(flag?.forceForRoleKeys ?? []),
  );
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [pending, startTransition] = React.useTransition();

  return (
    <Panel tone="flat" pad="lg">
      <form
        className="flex flex-col gap-5"
        action={(form) => {
          setErrors({});
          startTransition(async () => {
            const result = await upsertFeatureFlagAction({
              key: flag?.key ?? text(form, 'key'),
              description: text(form, 'description'),
              enabled,
              rollout: Number(text(form, 'rollout') || '100'),
              forceForRoleKeys: [...forced],
            });

            if (result.ok) {
              toast.success(flag === null ? 'Flag created' : 'Flag updated');
              onDone?.();
              router.refresh();
              return;
            }
            setErrors(result.fieldErrors ?? {});
            if (result.fieldErrors === undefined) toast.error('Could not save', result.message);
          });
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          {flag === null ? (
            <Field label="Key" htmlFor="key" required error={errors.key} className="flex-1">
              <Input name="key" placeholder="portal.new_dashboard" maxLength={64} />
            </Field>
          ) : (
            <div className="flex items-center gap-3">
              <code className="font-mono text-sm text-ink">{flag.key}</code>
              <Badge tone={flag.enabled ? 'success' : 'neutral'}>
                {flag.enabled ? 'on' : 'off'}
              </Badge>
            </div>
          )}

          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            label={`Enable ${flag?.key ?? 'this flag'}`}
          />
        </div>

        <Field label="Description" htmlFor="description" error={errors.description}>
          <Input name="description" defaultValue={flag?.description ?? ''} maxLength={200} />
        </Field>

        <Field
          label="Rollout"
          htmlFor="rollout"
          hint="Percentage of players who see it, once enabled. Deterministic per account."
          error={errors.rollout}
        >
          <Input
            name="rollout"
            type="number"
            min={0}
            max={100}
            defaultValue={String(flag?.rollout ?? 100)}
            className="w-28"
          />
        </Field>

        <fieldset className="flex flex-col gap-2">
          <legend className="x-eyebrow mb-2">Always on for</legend>
          <div className="flex flex-wrap gap-2">
            {roles.map((role) => (
              <Choice
                key={role.key}
                type="checkbox"
                label={role.name}
                className="w-auto"
                checked={forced.has(role.key)}
                onChange={() => {
                  setForced((current) => {
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

        <div className="flex items-center justify-between gap-4">
          {flag === null ? (
            <span />
          ) : (
            <span className="font-mono text-[0.625rem] text-ink-muted">
              updated {new Date(flag.updatedAt).toLocaleDateString('en-GB')}
            </span>
          )}
          <Button type="submit" variant="accent" size="sm" loading={pending}>
            {flag === null ? 'Create' : 'Save'}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
