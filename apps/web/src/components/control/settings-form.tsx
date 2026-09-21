'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Button, Field, Input, Panel, useToast } from '@xenon/ui';

import { setSettingAction } from '~/app/(control)/control/actions';

/**
 * Settings editor.
 *
 * One save per value rather than a single form submit. Settings are unrelated
 * to each other, and a batched save turns "I fixed the Discord invite" into an
 * audit entry that claims eight things changed.
 */

export interface SettingItem {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly value: string;
}

export function SettingsForm({
  groups,
}: {
  groups: readonly { category: string; items: readonly SettingItem[] }[];
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-8">
      {groups.map((group) => (
        <section key={group.category} className="flex flex-col gap-3">
          <h2 className="x-eyebrow">{group.category}</h2>
          <Panel tone="flat" pad="none" className="divide-y divide-line">
            {group.items.map((item) => (
              <SettingRow key={item.key} item={item} />
            ))}
          </Panel>
        </section>
      ))}
    </div>
  );
}

function SettingRow({ item }: { item: SettingItem }): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [value, setValue] = React.useState(item.value);
  const [pending, startTransition] = React.useTransition();

  const dirty = value !== item.value;

  return (
    <div className="p-5">
      <Field
        label={item.label}
        htmlFor={`setting-${item.key}`}
        hint={item.description}
        meta={<code className="font-mono text-[0.625rem]">{item.key}</code>}
      >
        <div className="flex gap-2">
          <Input
            id={`setting-${item.key}`}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
            }}
            placeholder="Not set"
          />
          <Button
            variant={dirty ? 'accent' : 'outline'}
            disabled={!dirty}
            loading={pending}
            onClick={() => {
              startTransition(async () => {
                const result = await setSettingAction(item.key, value);
                if (result.ok) {
                  toast.success('Saved', item.label);
                  router.refresh();
                  return;
                }
                toast.error('Could not save', result.message);
              });
            }}
          >
            Save
          </Button>
        </div>
      </Field>
    </div>
  );
}
