'use client';

import { Archive, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import {
  type BlueprintFeatures,
  type DepartmentSpace,
  featureLabels,
  type OrganizationSpace,
} from '@xenon/discord/config';
import { Badge, Button, Field, Input, Panel, Select, Switch, useToast } from '@xenon/ui';

import type { DepartmentView } from './setup-console';

import {
  saveDepartmentSpaceAction,
  saveFeaturesAction,
  saveOrganizationAction,
} from '~/app/(control)/control/discord/setup/actions';

/**
 * Blueprint features, department spaces and organisation spaces.
 *
 * Every switch here changes the desired state only. Nothing reaches Discord
 * until the next plan is reviewed and applied, which is what makes it safe to
 * toggle things while exploring.
 */
export function SpacesPanel({
  features,
  departments,
  organizations,
}: {
  features: BlueprintFeatures;
  departments: readonly DepartmentView[];
  organizations: readonly OrganizationSpace[];
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-6">
      <Features initial={features} />
      <Departments departments={departments} />
      <Organizations organizations={organizations} />
    </div>
  );
}

function useSave() {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = React.useTransition();
  const save = (
    run: () => Promise<{ ok: true } | { ok: false; message: string }>,
    done: string,
  ) => {
    startTransition(async () => {
      const result = await run();
      if (result.ok) {
        toast.success(done, 'Generate a plan to preview the Discord changes.');
        router.refresh();
      } else {
        toast.error('Could not save', result.message);
      }
    });
  };
  return { pending, save };
}

function Features({ initial }: { initial: BlueprintFeatures }): React.ReactElement {
  const [features, setFeatures] = React.useState(initial);
  const { pending, save } = useSave();
  const keys = Object.keys(featureLabels) as (keyof BlueprintFeatures)[];

  return (
    <Panel tone="flat" pad="lg">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="x-eyebrow">Blueprint features</h2>
          <p className="mt-1 text-xs text-ink-muted">
            Fewer, busier channels beat many quiet ones. Turn on only what the community will use.
          </p>
        </div>
        <Button
          size="sm"
          variant="accent"
          loading={pending}
          onClick={() => {
            save(() => saveFeaturesAction(features), 'Features saved');
          }}
        >
          Save
        </Button>
      </div>
      <div className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
        {keys.map((key) => (
          <label
            key={key}
            className="flex items-center justify-between gap-3 text-sm text-ink-secondary"
          >
            {featureLabels[key]}
            <Switch
              checked={features[key]}
              label={featureLabels[key]}
              onCheckedChange={(next) => {
                setFeatures((current) => ({ ...current, [key]: next }));
              }}
            />
          </label>
        ))}
      </div>
    </Panel>
  );
}

const SPACE_FIELDS: readonly [keyof DepartmentSpace, string][] = [
  ['enabled', 'Discord space'],
  ['private', 'Private category'],
  ['command', 'Command channel'],
  ['voice', 'Voice channels'],
  ['training', 'Training channel'],
  ['publicInfo', 'Public information'],
  ['recruitment', 'Recruitment channel'],
];

function Departments({
  departments,
}: {
  departments: readonly DepartmentView[];
}): React.ReactElement {
  return (
    <Panel tone="flat" pad="lg">
      <h2 className="x-eyebrow">Departments</h2>
      <p className="mt-1 text-xs text-ink-muted">
        Expanded from Xenon&apos;s department records. Enabling a space previews its roles, category
        and channels in the next plan - nothing is created until that plan is applied.
      </p>
      {departments.length === 0 ? (
        <p className="mt-4 text-sm text-ink-muted">No departments exist yet.</p>
      ) : (
        <div className="mt-4 flex flex-col divide-y divide-line">
          {departments.map((department) => (
            <DepartmentRow key={department.id} department={department} />
          ))}
        </div>
      )}
    </Panel>
  );
}

function DepartmentRow({ department }: { department: DepartmentView }): React.ReactElement {
  const [space, setSpace] = React.useState(department.space);
  const { pending, save } = useSave();
  const label = department.shortName ?? department.name;

  return (
    <div className="flex flex-col gap-3 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="text-sm text-ink">{department.name}</p>
          {department.published ? null : <Badge tone="neutral">draft</Badge>}
          {space.enabled ? <Badge tone="success">space on</Badge> : null}
        </div>
        <Button
          size="sm"
          variant="outline"
          loading={pending}
          onClick={() => {
            save(
              () => saveDepartmentSpaceAction({ departmentId: department.id, space: { ...space } }),
              `${label} saved`,
            );
          }}
        >
          Save
        </Button>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {SPACE_FIELDS.map(([key, text]) => (
          <label key={key} className="flex items-center gap-2 text-xs text-ink-secondary">
            <Switch
              checked={space[key] === true}
              disabled={key !== 'enabled' && !space.enabled}
              label={`${label}: ${text}`}
              onCheckedChange={(next) => {
                setSpace((current) => ({ ...current, [key]: next }));
              }}
            />
            {text}
          </label>
        ))}
      </div>
      {space.enabled ? (
        <p className="font-mono text-[0.625rem] text-ink-muted">
          role.dept.{department.slug}.member · role.dept.{department.slug}.command
          {space.private ? ` · category.dept.${department.slug}` : ''}
        </p>
      ) : null}
    </div>
  );
}

function Organizations({
  organizations,
}: {
  organizations: readonly OrganizationSpace[];
}): React.ReactElement {
  const { pending, save } = useSave();
  const [draft, setDraft] = React.useState({
    key: '',
    name: '',
    kind: 'CREW' as OrganizationSpace['kind'],
  });

  return (
    <Panel tone="flat" pad="lg">
      <h2 className="x-eyebrow">Organisations and businesses</h2>
      <p className="mt-1 text-xs text-ink-muted">
        Provisioned only for approved organisations, only when staff choose to. Private membership
        keeps the real name off the role so the Discord member list never becomes a metagaming leak.
        Archiving locks the space to management with its history kept; deletion is always a separate
        staff decision.
      </p>

      {organizations.length === 0 ? null : (
        <div className="mt-4 flex flex-col divide-y divide-line">
          {organizations.map((organization) => (
            <div
              key={organization.key}
              className="flex flex-wrap items-center justify-between gap-2 py-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-ink">{organization.name}</span>
                <Badge tone="neutral">{organization.kind.replace('_', ' ').toLowerCase()}</Badge>
                {organization.archived ? <Badge tone="warning">archived</Badge> : null}
                {organization.publicMembership ? (
                  <Badge tone="info">public membership</Badge>
                ) : null}
              </div>
              <Button
                size="sm"
                variant="ghost"
                loading={pending}
                onClick={() => {
                  save(
                    () =>
                      saveOrganizationAction({ ...organization, archived: !organization.archived }),
                    organization.archived ? 'Space restored' : 'Space archived',
                  );
                }}
              >
                <Archive aria-hidden /> {organization.archived ? 'Restore' : 'Archive'}
              </Button>
            </div>
          ))}
        </div>
      )}

      <form
        className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_12rem_auto] sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          save(
            () => saveOrganizationAction({ ...draft, staffVisible: true, publicMembership: false }),
            'Space recorded',
          );
          setDraft({ key: '', name: '', kind: 'CREW' });
        }}
      >
        <Field label="Name" htmlFor="org-name">
          <Input
            id="org-name"
            value={draft.name}
            maxLength={60}
            onChange={(event) => {
              setDraft({ ...draft, name: event.target.value });
            }}
          />
        </Field>
        <Field label="Key" htmlFor="org-key" hint="lowercase-with-dashes">
          <Input
            id="org-key"
            value={draft.key}
            maxLength={32}
            className="font-mono"
            onChange={(event) => {
              setDraft({
                ...draft,
                key: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''),
              });
            }}
          />
        </Field>
        <Field label="Kind" htmlFor="org-kind">
          <Select
            id="org-kind"
            value={draft.kind}
            onChange={(event) => {
              setDraft({ ...draft, kind: event.target.value as OrganizationSpace['kind'] });
            }}
          >
            <option value="CREW">Crew</option>
            <option value="STREET_GANG">Street gang</option>
            <option value="ORGANIZATION">Organisation</option>
            <option value="SYNDICATE">Syndicate</option>
            <option value="BUSINESS">Business</option>
          </Select>
        </Field>
        <Button
          type="submit"
          variant="outline"
          loading={pending}
          disabled={draft.key.length < 2 || draft.name.length < 2}
        >
          <Plus aria-hidden /> Add space
        </Button>
      </form>
    </Panel>
  );
}
