'use client';

import { Activity, Radar, ShieldCheck, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import type {
  BlueprintFeatures,
  DepartmentSpace,
  Diagnostic,
  EnforcementMode,
  ManualStep,
  OrganizationSpace,
  PlanCounts,
  PlanItem,
} from '@xenon/discord/web';
import {
  Badge,
  Button,
  EmptyState,
  Panel,
  Select,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from '@xenon/ui';
import { ProgressBar } from '@xenon/ui/motion';

import { AccessMatrix } from './access-matrix';
import { PlanView } from './plan-view';
import { RunHistory } from './run-history';
import { SpacesPanel } from './spaces-panel';

import {
  requestRunAction,
  saveEnforcementAction,
} from '~/app/(control)/control/discord/setup/actions';
import { ControlPage } from '~/components/control/control-page';

export interface AccessRowView {
  readonly key: string;
  readonly label: string;
  readonly visibility: string;
  readonly access: readonly { persona: string; view: boolean; send: boolean; manage: boolean }[];
}

export interface PlanData {
  readonly profile: 'EMPTY' | 'MANAGED' | 'ESTABLISHED';
  readonly generatedAt: string;
  readonly guildName: string;
  readonly counts: PlanCounts;
  readonly items: readonly PlanItem[];
  readonly diagnostics: readonly Diagnostic[];
  readonly manualSetup: readonly ManualStep[];
  readonly signature: readonly string[];
  readonly blueprintAudit?: { passed: boolean; matrix: readonly AccessRowView[] };
  readonly liveAudit?: { passed: boolean; matrix: readonly AccessRowView[] };
}

export interface RunView {
  readonly id: string;
  readonly mode: 'PLAN' | 'APPLY' | 'STATUS' | 'REPAIR' | 'VALIDATE' | 'CLEANUP';
  readonly status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'VALIDATION_FAILED';
  readonly source: string;
  readonly actorLabel: string;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly failure: string | null;
  readonly planned: PlanData | null;
  readonly progress:
    (Record<string, { done: number; total: number }> & { current?: string | null }) | null;
  readonly summary: Record<string, unknown> | null;
  readonly basedOnRunId: string | null;
}

export interface DepartmentView {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly shortName: string | null;
  readonly published: boolean;
  readonly space: DepartmentSpace;
}

const PHASES = [
  'ROLES',
  'CATEGORIES',
  'CHANNELS',
  'PERMISSIONS',
  'ASSETS',
  'PANELS',
  'AUTOMOD',
] as const;

export const statusTone = {
  QUEUED: 'info',
  RUNNING: 'progress',
  SUCCEEDED: 'success',
  FAILED: 'danger',
  VALIDATION_FAILED: 'danger',
} as const;

/**
 * The provisioning console.
 *
 * Plan first, always. The operator generates a plan, reads the diff, resolves
 * conflicts, and only then applies - with a typed phrase. While a run is in
 * flight the page refreshes itself and shows real task counts per phase, read
 * from the run row the bot updates.
 */
export function SetupConsole({
  guildId,
  guildName,
  blueprintVersion,
  runs,
  focus,
  selected,
  features,
  enforcement,
  canDestroy,
  managed,
  departments,
  organizations,
}: {
  guildId: string;
  guildName: string | null;
  blueprintVersion: string;
  runs: readonly RunView[];
  focus: RunView | null;
  selected: RunView | null;
  features: BlueprintFeatures;
  enforcement: EnforcementMode;
  canDestroy: boolean;
  managed: Record<string, number>;
  departments: readonly DepartmentView[];
  organizations: readonly OrganizationSpace[];
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = React.useTransition();

  const active = runs.find((run) => run.status === 'QUEUED' || run.status === 'RUNNING') ?? null;

  // Poll while the bot works. The run row is the source of truth for progress,
  // so a refresh is all the page needs.
  React.useEffect(() => {
    if (active === null) return undefined;
    const timer = setInterval(() => {
      router.refresh();
    }, 2_000);
    return () => {
      clearInterval(timer);
    };
  }, [active, router]);

  const request = (mode: 'PLAN' | 'STATUS' | 'VALIDATE') => {
    startTransition(async () => {
      const result = await requestRunAction({ mode });
      if (!result.ok) {
        toast.error('Could not start', result.message);
        return;
      }
      router.push(`/control/discord/setup?run=${result.data.runId}`);
    });
  };

  const plan = selected?.planned ?? null;
  const live = plan?.liveAudit;
  const totalManaged = Object.values(managed).reduce((sum, count) => sum + count, 0);
  const critical = plan?.diagnostics.filter((d) => d.severity === 'critical').length ?? 0;

  return (
    <ControlPage
      title="Server setup"
      breadcrumb={{ href: '/control/discord', label: 'Discord' }}
      lead="Discord infrastructure as code. Xenon plans every change against the live server, never deletes on its own, and applies only what you approve."
      loading={active !== null}
      actions={
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={pending || active !== null}
            onClick={() => {
              request('STATUS');
            }}
          >
            <Radar aria-hidden /> Status
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pending || active !== null}
            onClick={() => {
              request('VALIDATE');
            }}
          >
            <ShieldCheck aria-hidden /> Validate
          </Button>
          <Button
            variant="accent"
            size="sm"
            loading={pending}
            disabled={active !== null}
            onClick={() => {
              request('PLAN');
            }}
          >
            <Sparkles aria-hidden /> Generate plan
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Stat label="Blueprint" value={blueprintVersion} mono />
        <Stat
          label="Server"
          value={guildName ?? plan?.guildName ?? guildId}
          detail={plan === null ? 'Not yet analysed' : profileLabel[plan.profile]}
        />
        <Stat
          label="Managed resources"
          value={String(totalManaged)}
          detail={summariseManaged(managed)}
        />
        <Stat
          label="Drift"
          value={plan === null ? '—' : String(plan.counts.drift)}
          tone={plan !== null && plan.counts.drift > 0 ? 'warning' : undefined}
          detail={
            selected === null
              ? undefined
              : `as of ${new Date(selected.createdAt).toLocaleString('en-GB')}`
          }
        />
        <Stat
          label="Permissions"
          value={live === undefined ? '—' : live.passed && critical === 0 ? 'Healthy' : 'Failing'}
          tone={
            live === undefined ? undefined : live.passed && critical === 0 ? 'success' : 'danger'
          }
          detail={critical > 0 ? `${String(critical)} critical` : 'critical access tests'}
        />
      </div>

      {active === null ? null : <RunProgress run={active} />}

      {focus === null || active?.id === focus.id ? null : <RunOutcome run={focus} />}

      <Tabs defaultValue="plan">
        <TabsList>
          <TabsTrigger value="plan">Plan</TabsTrigger>
          <TabsTrigger value="permissions">Permissions</TabsTrigger>
          <TabsTrigger value="assets">Assets</TabsTrigger>
          <TabsTrigger value="panels">Panels</TabsTrigger>
          <TabsTrigger value="spaces">Blueprint & spaces</TabsTrigger>
          <TabsTrigger value="onboarding">Onboarding</TabsTrigger>
          <TabsTrigger value="diagnostics">Diagnostics</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="plan" className="pt-5">
          {selected === null || plan === null ? (
            <EmptyState
              icon={<Sparkles aria-hidden />}
              title="No plan yet"
              description="Generate a plan to see exactly what Xenon would create, update or repair. Planning changes nothing."
            />
          ) : (
            <PlanView run={selected} plan={plan} busy={active !== null} />
          )}
        </TabsContent>

        <TabsContent value="permissions" className="pt-5">
          <AccessMatrix
            rows={live?.matrix.length ? live.matrix : (plan?.blueprintAudit?.matrix ?? [])}
            source={live?.matrix.length ? 'live' : 'blueprint'}
          />
        </TabsContent>

        <TabsContent value="assets" className="pt-5">
          <PhaseList
            items={plan?.items.filter((item) => item.phase === 'ASSETS') ?? []}
            empty="No enabled assets. Import a pack with pnpm discord:assets:import, curate the manifest, then plan again."
            note="Capacity follows the server's boost level. Required assets upload first; anything that does not fit is reported, never forced."
          />
        </TabsContent>

        <TabsContent value="panels" className="pt-5">
          <PhaseList
            items={plan?.items.filter((item) => item.phase === 'PANELS') ?? []}
            empty="Panels appear once their channels are planned."
            note="Panels are edited in place. The city-status card refreshes itself when the city changes."
          />
        </TabsContent>

        <TabsContent value="spaces" className="pt-5">
          <SpacesPanel
            features={features}
            departments={departments}
            organizations={organizations}
          />
        </TabsContent>

        <TabsContent value="onboarding" className="pt-5">
          <div className="grid gap-3 lg:grid-cols-2">
            {(plan?.manualSetup ?? []).map((step) => (
              <Panel key={step.key} tone="flat" pad="md">
                <p className="x-eyebrow">Manual setup required</p>
                <h3 className="mt-1 font-display text-base font-semibold text-ink">{step.title}</h3>
                <p className="mt-1 text-xs text-ink-muted">{step.reason}</p>
                <ol className="mt-3 flex list-decimal flex-col gap-1.5 pl-5 text-xs leading-relaxed text-ink-secondary">
                  {step.steps.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ol>
              </Panel>
            ))}
            {plan === null ? (
              <p className="text-sm text-ink-muted">
                Generate a plan to see the manual steps for this server.
              </p>
            ) : null}
          </div>
        </TabsContent>

        <TabsContent value="diagnostics" className="pt-5">
          <Diagnostics diagnostics={plan?.diagnostics ?? []} />
        </TabsContent>

        <TabsContent value="history" className="pt-5">
          <RunHistory runs={runs} selectedId={selected?.id ?? null} canDestroy={canDestroy} />
        </TabsContent>
      </Tabs>

      <Panel
        tone="ghost"
        pad="md"
        className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <div>
          <p className="x-eyebrow">Enforcement</p>
          <p className="mt-1 text-xs text-ink-muted">
            Observe reports drift. Repair acts only when asked. Enforce restores critical
            integration resources - the review channel, the status card, mapped roles -
            automatically.
          </p>
        </div>
        <Select
          aria-label="Enforcement mode"
          className="w-44"
          defaultValue={enforcement}
          onChange={(event) => {
            const mode = event.target.value;
            startTransition(async () => {
              const result = await saveEnforcementAction(mode);
              if (result.ok) toast.success('Enforcement updated');
              else toast.error('Could not update', result.message);
            });
          }}
        >
          <option value="OBSERVE">Observe</option>
          <option value="REPAIR">Repair on request</option>
          <option value="ENFORCE">Enforce critical</option>
        </Select>
      </Panel>

      <p className="text-xs text-ink-muted">
        Try a development server first: point <code className="font-mono">DISCORD_GUILD_ID</code> at
        it, plan, apply, and review the layout before planning production. See{' '}
        <Link className="text-xenon hover:underline" href="/control/discord">
          Discord
        </Link>{' '}
        for bot health.
      </p>
    </ControlPage>
  );
}

const profileLabel = {
  EMPTY: 'Empty server — safe to build',
  MANAGED: 'Managed by Xenon',
  ESTABLISHED: 'Existing structure — review conflicts',
} as const;

function summariseManaged(managed: Record<string, number>): string {
  const parts = [
    ['ROLE', 'roles'],
    ['CHANNEL', 'channels'],
    ['CATEGORY', 'categories'],
    ['EMOJI', 'emoji'],
    ['PANEL', 'panels'],
  ] as const;
  return (
    parts
      .filter(([type]) => (managed[type] ?? 0) > 0)
      .map(([type, label]) => `${String(managed[type] ?? 0)} ${label}`)
      .join(' · ') || 'Nothing provisioned yet'
  );
}

function Stat({
  label,
  value,
  detail,
  tone,
  mono = false,
}: {
  label: string;
  value: string;
  detail?: string | undefined;
  tone?: 'success' | 'warning' | 'danger' | undefined;
  mono?: boolean;
}): React.ReactElement {
  const colour =
    tone === 'success'
      ? 'text-xenon'
      : tone === 'warning'
        ? 'text-warning'
        : tone === 'danger'
          ? 'text-danger'
          : 'text-ink';
  return (
    <Panel tone="flat" pad="md" className="min-w-0">
      <p className="x-eyebrow">{label}</p>
      <p
        className={`mt-1.5 truncate font-display text-lg font-semibold ${colour} ${mono ? 'font-mono text-sm' : ''}`}
      >
        {value}
      </p>
      {detail === undefined ? null : (
        <p className="mt-0.5 truncate text-[0.6875rem] text-ink-muted">{detail}</p>
      )}
    </Panel>
  );
}

function RunProgress({ run }: { run: RunView }): React.ReactElement {
  const phases = PHASES.map((phase) => ({
    phase,
    ...(run.progress?.[phase] ?? { done: 0, total: 0 }),
  })).filter((entry) => entry.total > 0);
  return (
    <Panel tone="raised" pad="lg" edgeLight>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Activity className="size-4 text-xenon" aria-hidden />
          <p className="x-eyebrow">
            {run.status === 'QUEUED'
              ? 'Waiting for the bot'
              : run.mode === 'PLAN'
                ? 'Analysing server'
                : `${run.mode.toLowerCase()} in progress`}
          </p>
        </div>
        <Badge tone={statusTone[run.status]}>{run.status.toLowerCase()}</Badge>
      </div>
      {phases.length === 0 ? (
        <p className="mt-3 text-xs text-ink-muted">
          {run.status === 'QUEUED'
            ? 'Queued. The bot picks runs up within seconds.'
            : 'Reading the server and building the plan…'}
        </p>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {phases.map((entry) => (
            <div key={entry.phase} className="flex flex-col gap-1.5">
              <div className="flex justify-between font-mono text-[0.6875rem] text-ink-secondary">
                <span>{entry.phase}</span>
                <span>
                  {entry.done} / {entry.total}
                </span>
              </div>
              <ProgressBar
                value={entry.done}
                max={entry.total}
                size="thin"
                label={`${entry.phase} progress`}
              />
            </div>
          ))}
        </div>
      )}
      {typeof run.progress?.current === 'string' ? (
        <p className="mt-3 truncate font-mono text-[0.6875rem] text-ink-muted">
          → {run.progress.current}
        </p>
      ) : null}
    </Panel>
  );
}

function RunOutcome({ run }: { run: RunView }): React.ReactElement | null {
  const summary = run.summary ?? {};
  const number = (value: unknown) => (typeof value === 'number' ? value : 0);
  const good = run.status === 'SUCCEEDED';
  if (good && run.mode !== 'APPLY' && run.mode !== 'REPAIR' && run.mode !== 'CLEANUP') return null;
  return (
    <Panel
      tone="ghost"
      pad="md"
      className={good ? 'border-xenon/30 bg-xenon/5' : 'border-danger/30 bg-danger/5'}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={statusTone[run.status]}>{run.status.replace('_', ' ').toLowerCase()}</Badge>
        <span className="text-sm text-ink-secondary">
          {run.mode.toLowerCase()} · {number(summary.applied)} applied
          {number(summary.failed) > 0 ? ` · ${String(number(summary.failed))} failed` : ''}
          {number(summary.skipped) > 0 ? ` · ${String(number(summary.skipped))} skipped` : ''}
          {good ? ' · permissions validated' : ''}
        </span>
      </div>
      {run.failure === null ? null : <p className="mt-2 text-sm text-danger">{run.failure}</p>}
    </Panel>
  );
}

const kindTone: Record<
  PlanItem['kind'],
  'success' | 'info' | 'warning' | 'danger' | 'neutral' | 'chrome'
> = {
  CREATE: 'success',
  UPDATE: 'info',
  MOVE: 'info',
  PERMISSION_CHANGE: 'warning',
  UNCHANGED: 'neutral',
  DRIFT: 'warning',
  CONFLICT: 'danger',
  MANUAL_REVIEW: 'chrome',
  CAPACITY_BLOCKED: 'chrome',
};

export function KindBadge({ kind }: { kind: PlanItem['kind'] }): React.ReactElement {
  return <Badge tone={kindTone[kind]}>{kind.replace('_', ' ').toLowerCase()}</Badge>;
}

function PhaseList({
  items,
  empty,
  note,
}: {
  items: readonly PlanItem[];
  empty: string;
  note: string;
}): React.ReactElement {
  if (items.length === 0) return <p className="text-sm text-ink-muted">{empty}</p>;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-ink-muted">{note}</p>
      <Panel tone="flat" pad="none" className="divide-y divide-line">
        {items.map((item) => (
          <div
            key={item.key}
            className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <p className="truncate text-sm text-ink">{item.label}</p>
              <p className="truncate font-mono text-[0.6875rem] text-ink-muted">{item.key}</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-ink-secondary">{item.summary}</span>
              <KindBadge kind={item.kind} />
            </div>
          </div>
        ))}
      </Panel>
    </div>
  );
}

function Diagnostics({ diagnostics }: { diagnostics: readonly Diagnostic[] }): React.ReactElement {
  if (diagnostics.length === 0)
    return (
      <p className="text-sm text-ink-muted">No diagnostics. Generate a plan or run validation.</p>
    );
  const order = ['critical', 'error', 'warning', 'info'] as const;
  const tone = {
    critical: 'danger',
    error: 'danger',
    warning: 'warning',
    info: 'neutral',
  } as const;
  return (
    <Panel tone="flat" pad="none" className="divide-y divide-line">
      {[...diagnostics]
        .sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity))
        .map((diagnostic, index) => (
          <div
            key={`${diagnostic.code}-${String(index)}`}
            className="flex flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-start sm:gap-4"
          >
            <Badge tone={tone[diagnostic.severity]} className="self-start">
              {diagnostic.severity}
            </Badge>
            <div className="min-w-0">
              <p className="text-sm text-ink-secondary">{diagnostic.message}</p>
              <p className="font-mono text-[0.625rem] text-ink-muted">
                {diagnostic.code}
                {diagnostic.key === undefined ? '' : ` · ${diagnostic.key}`}
              </p>
            </div>
          </div>
        ))}
    </Panel>
  );
}
