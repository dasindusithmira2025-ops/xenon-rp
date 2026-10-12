import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

import { statusLabels, statusTones, type StatusTone } from '@xenon/applications';
import { cn } from '@xenon/ui';

/** The lifecycle states, taken from the label table so there is one list to keep. */
type ApplicationStatus = keyof typeof statusLabels;

/**
 * Where an application stands, said before the answers.
 *
 * The page is a two-column layout whose second column - the timeline and the
 * staff decision - falls below the whole form on a phone. For a submitted or
 * decided application the form is read-only, so a player opening it from a
 * notification would scroll past every answer they wrote to learn the one thing
 * they came for. This puts the state, what it means and the decision note at the
 * top.
 *
 * Absent for the two states the form already speaks for: a draft is described
 * by the save indicator, and requested changes by the note the form shows above
 * the questions. No turnaround time appears anywhere, because staff have not
 * promised one.
 */

const summaries: Partial<Record<ApplicationStatus, string>> = {
  SUBMITTED:
    'It is in the review queue. You will be told here when something changes, and you cannot edit it unless a reviewer asks for changes.',
  RESUBMITTED: 'Your changes were received and it is back in the review queue.',
  UNDER_REVIEW: 'A reviewer has started reading it. You will be told here when they decide.',
  INTERVIEW_REQUIRED:
    'A reviewer wants to speak with you before deciding. You will be told here when it is arranged.',
  INTERVIEW_SCHEDULED: 'An interview has been arranged. The details are in your notifications.',
  INTERVIEW_COMPLETED: 'Your interview is done. The reviewer will update this application next.',
  APPROVED: 'This application was approved.',
  REJECTED:
    'This application was not successful. If you think the decision is wrong, you can appeal it.',
  WITHDRAWN: 'This application was withdrawn and will not be reviewed.',
  EXPIRED: 'This application expired and will not be reviewed.',
};

const panel: Record<StatusTone, string> = {
  neutral: 'border-line-strong bg-surface',
  progress: 'border-info/30 bg-info/5',
  attention: 'border-warning/30 bg-warning/5',
  success: 'border-xenon/30 bg-xenon-deep/15',
  danger: 'border-danger/30 bg-danger/5',
};

const label: Record<StatusTone, string> = {
  neutral: 'text-ink-muted',
  progress: 'text-info',
  attention: 'text-warning',
  success: 'text-xenon',
  danger: 'text-danger',
};

export function ApplicationStatusBanner({
  status,
  decisionNote,
}: {
  status: ApplicationStatus;
  decisionNote: string | null;
}): React.ReactElement | null {
  const summary = summaries[status];
  if (summary === undefined) return null;

  const tone = statusTones[status];
  // The interview request is the one place a reviewer's instructions (what to
  // prepare, where to look) are stored, and they appear nowhere else on the page.
  const showNote =
    (status === 'APPROVED' || status === 'REJECTED' || status === 'INTERVIEW_REQUIRED') &&
    decisionNote !== null;

  return (
    <section
      aria-label="Application status"
      className={cn('flex flex-col gap-3 rounded-lg border p-6', panel[tone])}
    >
      <p className={cn('x-eyebrow', label[tone])}>{statusLabels[status]}</p>
      <p className="max-w-2xl text-sm leading-relaxed text-ink-secondary">{summary}</p>
      {status === 'REJECTED' ? (
        <Link
          href="/support?tab=appeal"
          className="inline-flex items-center gap-2 self-start py-1 font-mono text-[0.6875rem] tracking-[0.16em] text-ink uppercase transition-colors duration-(--duration-fast) hover:text-xenon"
        >
          Open the appeal form <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      ) : null}
      {showNote ? (
        <div className="flex max-w-2xl flex-col gap-2 border-t border-line pt-3">
          <p className="x-eyebrow">Note from the reviewer</p>
          <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink">{decisionNote}</p>
        </div>
      ) : null}
    </section>
  );
}
