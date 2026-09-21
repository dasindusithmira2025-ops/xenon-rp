'use client';

import { ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Badge, Button, Panel, Select, Textarea, useToast } from '@xenon/ui';

import { updateReportAction } from '~/app/(control)/control/actions';

/**
 * One report, expandable.
 *
 * A list of collapsed summaries with the full detail one click away, rather
 * than a separate route: reports are triaged in batches, and losing your place
 * in the list to read one is the thing that makes that slow.
 */

export interface ReportRecord {
  readonly id: string;
  readonly publicId: string;
  readonly kind: string;
  readonly status: string;
  readonly priority: string;
  readonly summary: string;
  readonly details: string;
  readonly outcome: string | null;
  readonly createdAt: string;
  readonly occurredAt: string | null;
  readonly reporterName: string | null;
  readonly subjectName: string | null;
  readonly subjectPublicId: string | null;
  readonly assigneeId: string | null;
}

const statusTone: Record<string, 'info' | 'warning' | 'attention' | 'success' | 'neutral'> = {
  OPEN: 'info',
  INVESTIGATING: 'warning',
  AWAITING_INFO: 'attention',
  ACTIONED: 'success',
  DISMISSED: 'neutral',
  CLOSED: 'neutral',
};

export function ReportRow({
  report,
  staff,
  canManage,
}: {
  report: ReportRecord;
  staff: readonly { id: string; name: string }[];
  canManage: boolean;
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [outcome, setOutcome] = React.useState(report.outcome ?? '');
  const [pending, startTransition] = React.useTransition();

  const update = (patch: Record<string, unknown>, success: string): void => {
    startTransition(async () => {
      const result = await updateReportAction({
        reportId: report.id,
        status: report.status,
        priority: report.priority,
        ...patch,
      });
      if (result.ok) {
        toast.success(success);
        router.refresh();
        return;
      }
      toast.error('That did not go through', result.message);
    });
  };

  return (
    <Panel tone="flat" pad="none" className="overflow-hidden">
      <button
        type="button"
        onClick={() => {
          setOpen((current) => !current);
        }}
        aria-expanded={open}
        className="flex w-full items-center gap-4 p-4 text-left transition-colors hover:bg-elevated"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-sm text-ink">{report.summary}</span>
          <span className="font-mono text-[0.625rem] tracking-[0.12em] text-ink-muted">
            {report.publicId} · {report.kind.toLowerCase()}
            {report.subjectName === null ? null : <> · about {report.subjectName}</>}
          </span>
        </span>

        <Badge tone={report.kind === 'STAFF' ? 'danger' : 'chrome'}>
          {report.kind.toLowerCase()}
        </Badge>
        <Badge tone={statusTone[report.status] ?? 'neutral'}>
          {report.status.toLowerCase().replace(/_/g, ' ')}
        </Badge>
        <ChevronDown
          className={`size-4 shrink-0 text-ink-muted transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>

      {open ? (
        <div className="grid gap-5 border-t border-line p-5 lg:grid-cols-[minmax(0,1fr)_16rem]">
          <div className="flex min-w-0 flex-col gap-4">
            <dl className="grid gap-3 text-xs sm:grid-cols-3">
              <div>
                <dt className="x-eyebrow">Reporter</dt>
                <dd className="mt-1 text-ink-secondary">{report.reporterName ?? 'unknown'}</dd>
              </div>
              <div>
                <dt className="x-eyebrow">Subject</dt>
                <dd className="mt-1 text-ink-secondary">
                  {report.subjectPublicId === null ? (
                    (report.subjectName ?? '—')
                  ) : (
                    <Link
                      href={`/control/players/${report.subjectPublicId}`}
                      className="text-xenon hover:underline"
                    >
                      {report.subjectName}
                    </Link>
                  )}
                </dd>
              </div>
              <div>
                <dt className="x-eyebrow">Occurred</dt>
                <dd className="mt-1 text-ink-secondary">
                  {report.occurredAt === null
                    ? 'not stated'
                    : new Date(report.occurredAt).toLocaleString('en-GB')}
                </dd>
              </div>
            </dl>

            <div>
              <p className="x-eyebrow">Details</p>
              <p className="mt-2 rounded-md border border-line bg-black p-4 text-sm leading-relaxed whitespace-pre-wrap text-ink-secondary">
                {report.details}
              </p>
            </div>
          </div>

          {canManage ? (
            <div className="flex flex-col gap-3">
              <Select
                value={report.status}
                aria-label="Status"
                disabled={pending}
                onChange={(event) => {
                  update({ status: event.target.value }, 'Status updated');
                }}
              >
                <option value="OPEN">Open</option>
                <option value="INVESTIGATING">Investigating</option>
                <option value="AWAITING_INFO">Awaiting info</option>
                <option value="ACTIONED">Actioned</option>
                <option value="DISMISSED">Dismissed</option>
                <option value="CLOSED">Closed</option>
              </Select>

              <Select
                value={report.priority}
                aria-label="Priority"
                disabled={pending}
                onChange={(event) => {
                  update({ priority: event.target.value }, 'Priority updated');
                }}
              >
                <option value="LOW">Low</option>
                <option value="NORMAL">Normal</option>
                <option value="HIGH">High</option>
                <option value="URGENT">Urgent</option>
              </Select>

              <Select
                value={report.assigneeId ?? ''}
                aria-label="Assignee"
                disabled={pending}
                onChange={(event) => {
                  const next = event.target.value;
                  update({ assigneeId: next === '' ? null : next }, 'Assignee updated');
                }}
              >
                <option value="">Unassigned</option>
                {staff.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </Select>

              <Textarea
                value={outcome}
                rows={4}
                maxLength={4000}
                placeholder="What was done. Staff only."
                onChange={(event) => {
                  setOutcome(event.target.value);
                }}
              />

              <Button
                variant="outline"
                size="sm"
                loading={pending}
                onClick={() => {
                  update({ outcome }, 'Outcome saved');
                }}
              >
                Save outcome
              </Button>
            </div>
          ) : (
            <p className="text-xs text-ink-muted">You can read this report but not action it.</p>
          )}
        </div>
      ) : null}
    </Panel>
  );
}
