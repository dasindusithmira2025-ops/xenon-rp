'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { CLEANUP_PHRASE } from '@xenon/discord/config';
import { Badge, Button, ConfirmDialog, Panel, Switch, useToast } from '@xenon/ui';

import { type RunView, statusTone } from './setup-console';

import { requestRunAction } from '~/app/(control)/control/discord/setup/actions';

/**
 * Provisioning history, newest first.
 *
 * A failed apply can be cleaned up from here: only resources that run created,
 * never anything with member history unless forced, and only for holders of
 * the destructive capability.
 */
export function RunHistory({
  runs,
  selectedId,
  canDestroy,
}: {
  runs: readonly RunView[];
  selectedId: string | null;
  canDestroy: boolean;
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = React.useTransition();
  const [target, setTarget] = React.useState<RunView | null>(null);
  const [force, setForce] = React.useState(false);

  if (runs.length === 0) return <p className="text-sm text-ink-muted">No provisioning runs yet.</p>;

  return (
    <>
      <Panel tone="flat" pad="none" className="divide-y divide-line">
        {runs.map((run) => {
          const summary = run.summary ?? {};
          const applied = typeof summary.applied === 'number' ? summary.applied : null;
          return (
            <div
              key={run.id}
              className={`flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between ${run.id === selectedId ? 'bg-elevated' : ''}`}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Badge tone="chrome">{run.mode.toLowerCase()}</Badge>
                <Badge tone={statusTone[run.status]}>
                  {run.status.replace('_', ' ').toLowerCase()}
                </Badge>
                <span className="text-xs text-ink-secondary">
                  {run.actorLabel} · {run.source.toLowerCase()}
                </span>
                <span className="font-mono text-[0.625rem] text-ink-muted">
                  {new Date(run.createdAt).toLocaleString('en-GB')}
                </span>
                {applied === null ? null : (
                  <span className="text-xs text-ink-muted">{applied} applied</span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {run.planned === null ? null : (
                  <Button asChild size="sm" variant="ghost">
                    <Link href={`/control/discord/setup?run=${run.id}`}>View</Link>
                  </Button>
                )}
                {canDestroy &&
                (run.mode === 'APPLY' || run.mode === 'REPAIR') &&
                run.status !== 'SUCCEEDED' &&
                run.status !== 'RUNNING' &&
                run.status !== 'QUEUED' ? (
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      setTarget(run);
                    }}
                  >
                    Clean up
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
      </Panel>

      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        tone="danger"
        title="Delete what this run created"
        description={
          <div className="flex flex-col gap-3">
            <p>
              Xenon deletes only channels, categories, roles and emoji created by this exact run.
              Channels with member messages and roles it cannot verify are kept unless you force it.
              Nothing else on the server is touched.
            </p>
            <label className="flex items-center gap-2 text-xs text-danger">
              <Switch checked={force} onCheckedChange={setForce} label="Force" />
              Force: also delete channels with history and roles with members
            </label>
          </div>
        }
        confirmLabel="Delete"
        confirmPhrase={CLEANUP_PHRASE}
        loading={pending}
        onConfirm={() => {
          const run = target;
          if (run === null) return;
          startTransition(async () => {
            const result = await requestRunAction({
              mode: 'CLEANUP',
              basedOnRunId: run.id,
              confirmation: CLEANUP_PHRASE,
              force,
            });
            setTarget(null);
            if (result.ok) {
              toast.success('Cleanup started');
              router.push(`/control/discord/setup?run=${result.data.runId}`);
            } else {
              toast.error('Nothing deleted', result.message);
            }
          });
        }}
      />
    </>
  );
}
