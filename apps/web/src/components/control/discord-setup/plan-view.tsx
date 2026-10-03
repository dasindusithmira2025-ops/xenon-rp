'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { PROVISION_PHRASE } from '@xenon/discord/config';
import type { PlanItem } from '@xenon/discord/web';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Badge,
  Button,
  ConfirmDialog,
  Panel,
  Select,
  Switch,
  useToast,
} from '@xenon/ui';

import { KindBadge, type PlanData, type RunView } from './setup-console';

import {
  requestRunAction,
  resolveConflictAction,
} from '~/app/(control)/control/discord/setup/actions';

const GROUPS: readonly { kind: PlanItem['kind']; title: string; hint: string }[] = [
  {
    kind: 'CONFLICT',
    title: 'Conflicts',
    hint: 'Something with this name exists and Xenon does not own it. Decide what happens.',
  },
  { kind: 'CREATE', title: 'To create', hint: 'New Xenon-managed resources.' },
  { kind: 'UPDATE', title: 'To update', hint: 'Blueprint changes to resources Xenon manages.' },
  {
    kind: 'PERMISSION_CHANGE',
    title: 'Permission changes',
    hint: 'Overwrites brought back to their policy.',
  },
  { kind: 'MOVE', title: 'Hierarchy', hint: 'Role order below the Xenon bot role.' },
  {
    kind: 'DRIFT',
    title: 'Drift',
    hint: 'Changed in Discord since Xenon applied it. Repair restores strict fields; soft ones on request.',
  },
  {
    kind: 'MANUAL_REVIEW',
    title: 'Needs review',
    hint: 'Xenon will not act on these without a person.',
  },
  {
    kind: 'CAPACITY_BLOCKED',
    title: 'Over capacity',
    hint: 'Assets that do not fit the server’s current boost level.',
  },
  { kind: 'UNCHANGED', title: 'Unchanged', hint: 'Already matches the blueprint.' },
];

const APPLY_KINDS = new Set<PlanItem['kind']>(['CREATE', 'UPDATE', 'MOVE', 'PERMISSION_CHANGE']);

export function PlanView({
  run,
  plan,
  busy,
}: {
  run: RunView;
  plan: PlanData;
  busy: boolean;
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = React.useTransition();
  const [dialog, setDialog] = React.useState<'APPLY' | 'REPAIR' | null>(null);
  const [acknowledged, setAcknowledged] = React.useState(false);
  const [includeSoft, setIncludeSoft] = React.useState(false);

  const isPlan = run.mode === 'PLAN' && run.status === 'SUCCEEDED';
  // Captured once per mount: the page re-renders on refresh, which is when a
  // stale plan should start reading as expired.
  const [now] = React.useState(() => Date.now());
  const expired = now - new Date(run.completedAt ?? run.createdAt).getTime() > 30 * 60_000;
  const applicable = plan.items.filter(
    (item) => APPLY_KINDS.has(item.kind) && item.blockedBy === undefined,
  ).length;
  const drifted = plan.items.filter(
    (item) => item.kind === 'DRIFT' && (item.strictDrift === true || includeSoft),
  ).length;
  const established = plan.profile === 'ESTABLISHED';

  const summary = [
    [plan.counts.unchanged, 'unchanged'],
    [plan.counts.create, 'to create'],
    [plan.counts.update, 'to update'],
    [plan.counts.permission, 'permission changes'],
    [plan.counts.move, 'hierarchy'],
    [plan.counts.drift, 'drifted'],
    [plan.counts.conflict, plan.counts.conflict === 1 ? 'conflict' : 'conflicts'],
    [plan.counts.manual, 'need review'],
    [plan.counts.capacity, 'over capacity'],
  ].filter(([count]) => Number(count) > 0) as [number, string][];

  const confirm = () => {
    const mode = dialog;
    if (mode === null) return;
    startTransition(async () => {
      const result = await requestRunAction({
        mode,
        basedOnRunId: run.id,
        confirmation: PROVISION_PHRASE,
        acknowledgeEstablished: acknowledged,
        includeSoft,
      });
      setDialog(null);
      if (!result.ok) {
        toast.error('Nothing changed', result.message);
        return;
      }
      toast.success(
        mode === 'APPLY' ? 'Apply started' : 'Repair started',
        'Progress appears above as the bot works.',
      );
      router.push(`/control/discord/setup?run=${result.data.runId}`);
    });
  };

  return (
    <div className="flex flex-col gap-5">
      <Panel
        tone="flat"
        pad="md"
        className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"
      >
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="chrome">{run.mode.toLowerCase()}</Badge>
            <span className="font-mono text-[0.6875rem] text-ink-muted">
              {new Date(plan.generatedAt).toLocaleString('en-GB')} · {run.actorLabel}
            </span>
          </div>
          <p className="text-sm text-ink-secondary">
            {summary.map(([count, label], index) => (
              <React.Fragment key={label}>
                {index === 0 ? null : <span className="text-ink-muted"> · </span>}
                <strong className="font-semibold text-ink">{count}</strong> {label}
              </React.Fragment>
            ))}
          </p>
          {isPlan && expired ? (
            <p className="text-xs text-warning">
              This plan is more than 30 minutes old. Generate a fresh one to apply.
            </p>
          ) : null}
        </div>

        {isPlan ? (
          <div className="flex flex-wrap items-center gap-3">
            {plan.counts.drift > 0 ? (
              <label className="flex items-center gap-2 text-xs text-ink-secondary">
                <Switch
                  checked={includeSoft}
                  onCheckedChange={setIncludeSoft}
                  label="Include soft drift"
                />
                Include names and topics
              </label>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              disabled={busy || expired || drifted === 0}
              onClick={() => {
                setDialog('REPAIR');
              }}
            >
              Repair {drifted}
            </Button>
            <Button
              variant="accent"
              size="sm"
              disabled={busy || expired || applicable === 0}
              onClick={() => {
                setDialog('APPLY');
              }}
            >
              Apply {applicable} changes
            </Button>
          </div>
        ) : null}
      </Panel>

      <Accordion
        type="multiple"
        defaultValue={[
          'CONFLICT',
          'CREATE',
          'UPDATE',
          'PERMISSION_CHANGE',
          'DRIFT',
          'MANUAL_REVIEW',
        ]}
      >
        {GROUPS.map((group) => {
          const items = plan.items.filter((item) => item.kind === group.kind);
          if (items.length === 0) return null;
          return (
            <AccordionItem key={group.kind} value={group.kind}>
              <AccordionTrigger className="text-sm">
                <span className="flex items-center gap-3">
                  <KindBadge kind={group.kind} />
                  <span>{group.title}</span>
                  <span className="font-mono text-xs text-ink-muted">{items.length}</span>
                </span>
              </AccordionTrigger>
              <AccordionContent>
                <p className="pb-3 text-xs text-ink-muted">{group.hint}</p>
                <div className="flex flex-col divide-y divide-line rounded-md border border-line">
                  {items.map((item) => (
                    <PlanRow key={item.key} item={item} planRunId={isPlan ? run.id : null} />
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>

      <ConfirmDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title={
          dialog === 'REPAIR'
            ? 'Repair Xenon resources'
            : 'This will modify the Xenon Discord server'
        }
        description={
          <div className="flex flex-col gap-3">
            <p>
              {dialog === 'REPAIR'
                ? `Xenon will restore ${String(drifted)} drifted resources it manages. Nothing unmanaged is touched and nothing is deleted.`
                : `Xenon will apply exactly the ${String(applicable)} changes in this plan. If the server changed since the plan was generated, the run stops and asks for a fresh plan.`}
            </p>
            {established ? (
              <label className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 p-3 text-xs text-warning">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-[var(--color-warning)]"
                  checked={acknowledged}
                  onChange={(event) => {
                    setAcknowledged(event.target.checked);
                  }}
                />
                This server already has structure Xenon does not manage. I have reviewed every
                conflict.
              </label>
            ) : null}
          </div>
        }
        confirmLabel={dialog === 'REPAIR' ? 'Repair' : 'Apply'}
        confirmPhrase={PROVISION_PHRASE}
        loading={pending}
        onConfirm={confirm}
      />
    </div>
  );
}

function PlanRow({
  item,
  planRunId,
}: {
  item: PlanItem;
  planRunId: string | null;
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = React.useTransition();
  const [resolution, setResolution] = React.useState('ADOPT');

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="truncate text-sm text-ink">{item.label}</p>
          <p className="truncate font-mono text-[0.625rem] text-ink-muted">{item.key}</p>
        </div>
        <p className="text-xs text-ink-secondary sm:max-w-[55%] sm:text-right">{item.summary}</p>
      </div>

      {item.changes.length === 0 ? null : (
        <ul className="flex flex-col gap-1 font-mono text-[0.6875rem]">
          {item.changes.map((change) => (
            <li key={change.field} className="flex flex-wrap items-center gap-2 text-ink-muted">
              <Badge tone={change.strict ? 'warning' : 'neutral'}>
                {change.strict ? 'strict' : 'soft'}
              </Badge>
              <span className="text-ink-secondary">{change.field}</span>
              <span className="line-through decoration-danger/60">{change.from || '∅'}</span>
              <span>→</span>
              <span className="text-xenon">{change.to || '∅'}</span>
            </li>
          ))}
        </ul>
      )}

      {item.kind === 'CONFLICT' && planRunId !== null ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select
            aria-label={`Resolution for ${item.label}`}
            className="h-8 w-full text-xs sm:w-60"
            value={resolution}
            onChange={(event) => {
              setResolution(event.target.value);
            }}
          >
            <option value="ADOPT">Adopt — Xenon manages it, history kept</option>
            <option value="KEEP_UNMANAGED">Keep unmanaged — leave it alone</option>
            <option value="CREATE_ALTERNATIVE">Create alternative — separate resource</option>
            <option value="MANUAL">Manual — decide later</option>
          </Select>
          <Button
            size="sm"
            variant="outline"
            loading={pending}
            onClick={() => {
              startTransition(async () => {
                const result = await resolveConflictAction({
                  planRunId,
                  key: item.key,
                  resolution,
                });
                if (result.ok) {
                  toast.success('Decision recorded', 'Generate a new plan to see its effect.');
                  router.refresh();
                } else {
                  toast.error('Could not record', result.message);
                }
              });
            }}
          >
            Record decision
          </Button>
        </div>
      ) : null}
    </div>
  );
}
