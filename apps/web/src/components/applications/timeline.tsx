'use client';

import { cn } from '@xenon/ui';
import { instant, motion, useReducedMotion } from '@xenon/ui/motion';

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
  const reduced = useReducedMotion();

  const visible = entries.filter(
    (entry) => showInternal || (entry.type !== 'NOTE_ADDED' && entry.type !== 'SAVED'),
  );

  if (visible.length === 0) {
    return <p className="text-sm text-ink-muted">Nothing has happened yet.</p>;
  }

  return (
    <ol className="relative flex flex-col gap-5 pl-6">
      {/*
        The connecting rail, drawn once as the timeline comes into view.

        A static line between dots is a list with decoration; a line that draws
        itself from the first event to the most recent one is the story of the
        application, which is what a timeline is for. It fills the whole rail
        because every event on it has already happened - the line is never
        extended past the last thing that actually occurred.
      */}
      <span aria-hidden className="absolute inset-y-0 left-0 w-px bg-line">
        <motion.span
          className="block size-full origin-top bg-xenon/45"
          initial={{ scaleY: 0 }}
          whileInView={{ scaleY: 1 }}
          viewport={{ once: true, amount: 0.2 }}
          transition={instant(reduced, { duration: 0.9, ease: [0.16, 1, 0.3, 1] })}
        />
      </span>

      {visible.map((entry, index) => {
        const detail = copy[entry.type];
        // The head of the timeline is the application's current state, so it is
        // the one node that is allowed to look live.
        const latest = index === visible.length - 1;

        return (
          <motion.li
            key={entry.id}
            className="relative"
            initial={{ opacity: 0, x: -6 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, amount: 0.6 }}
            // Trails the rail as it draws, so each event appears as the line
            // reaches it rather than all six arriving at once.
            transition={instant(reduced, {
              duration: 0.4,
              delay: 0.12 + index * 0.08,
              ease: [0.16, 1, 0.3, 1],
            })}
          >
            <span
              className={cn(
                'absolute top-1.5 -left-[1.8125rem] size-2 rounded-full ring-4 ring-void',
                dotTone[detail.tone],
              )}
              aria-hidden
            >
              {latest && detail.tone === 'accent' ? (
                <span className="x-status-ring absolute inset-0 rounded-full bg-xenon" />
              ) : null}
            </span>
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
          </motion.li>
        );
      })}
    </ol>
  );
}
