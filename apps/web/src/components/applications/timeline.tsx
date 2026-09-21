import { cn } from '@xenon/ui';

/**
 * Application timeline.
 *
 * Built from `ApplicationEvent`, which every state transition writes inside the
 * same transaction as the change itself. That is why this is a record rather
 * than a reconstruction: there is no path that moves an application without
 * leaving a row here.
 *
 * Timestamps are real. Nothing is inferred or rounded to make the story
 * tidier.
 */

export interface TimelineEntry {
  readonly id: string;
  readonly type: ApplicationEventType;
  readonly createdAt: Date;
  readonly actorLabel: string | null;
  readonly source: string;
}

const copy = {
  CREATED: { label: 'Application started', tone: 'neutral' },
  SAVED: { label: 'Progress saved', tone: 'neutral' },
  SUBMITTED: { label: 'Submitted for review', tone: 'accent' },
  CLAIMED: { label: 'A reviewer picked it up', tone: 'accent' },
  UNCLAIMED: { label: 'Returned to the queue', tone: 'neutral' },
  ASSIGNED: { label: 'Assigned to a reviewer', tone: 'accent' },
  STATUS_CHANGED: { label: 'Status changed', tone: 'neutral' },
  CHANGES_REQUESTED: { label: 'Changes requested', tone: 'warn' },
  RESUBMITTED: { label: 'Resubmitted', tone: 'accent' },
  INTERVIEW_REQUESTED: { label: 'Interview requested', tone: 'warn' },
  INTERVIEW_SCHEDULED: { label: 'Interview scheduled', tone: 'accent' },
  INTERVIEW_COMPLETED: { label: 'Interview completed', tone: 'accent' },
  APPROVED: { label: 'Approved', tone: 'accent' },
  REJECTED: { label: 'Not successful', tone: 'bad' },
  WITHDRAWN: { label: 'Withdrawn', tone: 'neutral' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },
  ARCHIVED: { label: 'Archived', tone: 'neutral' },
  COMMENTED: { label: 'A reviewer left a note for you', tone: 'neutral' },
  NOTE_ADDED: { label: 'Internal note added', tone: 'neutral' },
} as const satisfies Record<string, { label: string; tone: 'neutral' | 'accent' | 'warn' | 'bad' }>;

/**
 * The event names this component knows how to render.
 *
 * Derived from the copy table rather than imported from the Prisma enum: a
 * client component must not pull in `@xenon/database`, and deriving it here
 * means adding an event type without wording for it is a type error at the
 * call site.
 */
export type ApplicationEventType = keyof typeof copy;

const dotTone = {
  neutral: 'bg-chrome-500',
  accent: 'bg-xenon',
  warn: 'bg-warning',
  bad: 'bg-danger',
} as const;

export function ApplicationTimeline({
  entries,
  showInternal = false,
}: {
  entries: readonly TimelineEntry[];
  /** Staff see internal notes; applicants do not. */
  showInternal?: boolean;
}): React.ReactElement {
  const visible = entries.filter(
    (entry) => showInternal || (entry.type !== 'NOTE_ADDED' && entry.type !== 'SAVED'),
  );

  if (visible.length === 0) {
    return <p className="text-sm text-ink-muted">Nothing has happened yet.</p>;
  }

  return (
    <ol className="relative flex flex-col gap-5 border-l border-line pl-6">
      {visible.map((entry) => {
        const detail = copy[entry.type];
        return (
          <li key={entry.id} className="relative">
            <span
              className={cn(
                'absolute top-1.5 -left-[1.8125rem] size-2 rounded-full ring-4 ring-void',
                dotTone[detail.tone],
              )}
              aria-hidden
            />
            <p className="text-sm text-ink">{detail.label}</p>
            <p className="mt-0.5 font-mono text-[0.625rem] tracking-[0.12em] text-ink-muted uppercase">
              <time dateTime={entry.createdAt.toISOString()}>
                {entry.createdAt.toLocaleString('en-GB', {
                  day: '2-digit',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
              {entry.actorLabel === null ? null : <> · {entry.actorLabel}</>}
              {entry.source !== 'WEB' ? <> · via {entry.source.toLowerCase()}</> : null}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
