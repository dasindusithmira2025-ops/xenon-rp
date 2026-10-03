'use client';

import { AlertTriangle, Check, CloudOff, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import type { RenderableSection } from '@xenon/applications';
import { Button, cn, ConfirmDialog, Panel, useToast } from '@xenon/ui';
import {
  AnimatePresence,
  LoadingRail,
  motion,
  ProgressBar,
  SegmentedProgress,
  Spinner,
  SuccessCheck,
} from '@xenon/ui/motion';
import { submissionProgress, validateSubmission, visibleQuestions } from '@xenon/validation';

import { QuestionField } from './question-field';
import { type AnswerValues, type SaveStatus, useAutosave } from './use-autosave';

import { submitApplicationAction } from '~/app/(portal)/portal/applications/actions';

/**
 * The application form.
 *
 * Long, and deliberately so. The design decisions worth knowing:
 *
 *  - Every edit is persisted server-side. Nothing lives only here.
 *  - Validation runs locally for feedback but is not the gate: `submitApplication`
 *    re-validates against the stored answers, which is the only check that
 *    counts.
 *  - Conditional questions disappear when their branch is not taken, and the
 *    progress count follows, so "12 of 14" means twelve of the fourteen that
 *    actually apply to this applicant.
 *  - Submitting flushes the autosave first, so the server validates what the
 *    player can see rather than what it happened to have received.
 */

export interface ApplicationFormProps {
  readonly submissionId: string;
  readonly publicId: string;
  readonly templateName: string;
  readonly sections: readonly RenderableSection[];
  readonly initialAnswers: AnswerValues;
  readonly initialRevision: number;
  readonly editable: boolean;
  readonly decisionNote: string | null;
  readonly characters: readonly { id: string; label: string }[];
}

export function ApplicationForm({
  submissionId,
  publicId,
  templateName,
  sections,
  initialAnswers,
  initialRevision,
  editable,
  decisionNote,
  characters,
}: ApplicationFormProps): React.ReactElement {
  const router = useRouter();
  const toast = useToast();

  const autosaveState = useAutosave(submissionId, initialRevision, initialAnswers, {
    enabled: editable,
  });
  const { values, change, flush, retry } = autosaveState;

  const [showErrors, setShowErrors] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [submitting, startSubmitting] = React.useTransition();
  /*
   * Held from the moment the server confirms the submission until the refreshed
   * server view replaces this component.
   *
   * That window is real work, not a pause invented to show an animation:
   * `router.refresh()` has to round-trip and re-render the page as read-only.
   * Without this the form simply blinks into a different layout, which is a
   * poor ending for forty minutes of writing.
   */
  const [submitted, setSubmitted] = React.useState(false);

  const allQuestions = React.useMemo(
    () => sections.flatMap((section) => section.questions),
    [sections],
  );

  const visible = React.useMemo(
    () => new Set(visibleQuestions(allQuestions, values).map((question) => question.key)),
    [allQuestions, values],
  );

  const errors = React.useMemo(
    () => validateSubmission(allQuestions, values),
    [allQuestions, values],
  );

  const progress = React.useMemo(
    () => submissionProgress(allQuestions, values),
    [allQuestions, values],
  );

  /*
   * Completion per section, from the same function as the overall figure.
   *
   * A section with no required questions counts as complete: it cannot be
   * finished any further, and leaving it grey forever would mean the segmented
   * rail could never fill even on a perfect application.
   */
  const sectionProgress = React.useMemo(
    () =>
      sections.map((section) => {
        const measured = submissionProgress(section.questions, values);
        return { id: section.id, complete: measured.answered >= measured.total };
      }),
    [sections, values],
  );

  const complete = Object.keys(errors).length === 0;

  const submit = (): void => {
    startSubmitting(async () => {
      // Flush first: the server validates stored answers, so submitting before
      // the last keystroke lands would fail on something already typed.
      const settled = await flush();
      if (!settled) {
        toast.error(
          'Your last changes have not saved',
          'Wait a moment for the save to finish, then submit again.',
        );
        return;
      }

      const result = await submitApplicationAction(submissionId);
      if (result.ok) {
        setConfirmOpen(false);
        setSubmitted(true);
        router.refresh();
        return;
      }

      setConfirmOpen(false);
      setShowErrors(true);
      toast.error('Not submitted', result.message);
      // Field errors come back keyed by question; jump to the first one so a
      // long form does not leave the player hunting.
      const firstKey = Object.keys(result.fieldErrors ?? {})[0];
      if (firstKey !== undefined) {
        document.getElementById(`question-${firstKey}`)?.scrollIntoView({ block: 'center' });
      }
    });
  };

  if (submitted) {
    return <SubmittedPanel publicId={publicId} />;
  }

  return (
    <div className="flex flex-col gap-8">
      {editable ? <SaveIndicator state={autosaveState} onRetry={retry} /> : null}

      {decisionNote === null ? null : (
        <Panel tone="ghost" pad="lg" className="border-warning/30 bg-warning/5">
          <p className="x-eyebrow text-warning">Changes requested</p>
          <p className="mt-2.5 text-sm leading-relaxed whitespace-pre-wrap text-ink-secondary">
            {decisionNote}
          </p>
        </Panel>
      )}

      {/*
        The progress rail.

        Sticky, because on a form this long the answer to "how much is left" has
        to be available without scrolling back up. Every figure on it is derived
        from `submissionProgress`, which counts the required questions that are
        actually visible to this applicant - so a conditional branch not taken
        lowers the denominator rather than leaving an unreachable question
        holding the bar at 94%.
      */}
      <Panel tone="flat" pad="lg" className="sticky top-4 z-20 backdrop-blur-sm">
        <div className="flex items-baseline justify-between gap-4">
          <p className="text-sm font-medium text-ink">{templateName}</p>
          <p className="x-tabular font-mono text-xs text-ink-secondary">
            <span className="text-ink">{Math.round(progress.ratio * 100)}%</span> complete
          </p>
        </div>

        <ProgressBar
          value={progress.answered}
          max={Math.max(progress.total, 1)}
          className="mt-3"
          label="Application progress"
        />

        <div className="mt-3 flex items-center justify-between gap-4">
          {/* Sections as segments. A bar says "most of the way"; segments say
              "three done, this one open, two to go", which is what someone
              deciding whether to finish tonight actually wants to know. */}
          <SegmentedProgress
            value={sectionProgress.filter((section) => section.complete).length}
            total={Math.max(sectionProgress.length, 1)}
            size="thin"
            className="max-w-48"
            label="Sections completed"
          />
          <p className="x-tabular shrink-0 font-mono text-[0.625rem] tracking-[0.12em] text-ink-muted uppercase">
            {progress.answered} / {progress.total} required
          </p>
        </div>
      </Panel>

      {sections.map((section, sectionIndex) => {
        const sectionQuestions = section.questions.filter((question) => visible.has(question.key));
        if (sectionQuestions.length === 0) return null;

        const complete = sectionProgress[sectionIndex]?.complete ?? false;

        return (
          <section key={section.id} className="flex flex-col gap-6">
            <div className="flex flex-col gap-2 border-b border-line pb-4">
              <div className="flex items-center gap-2.5">
                <p className="x-eyebrow">
                  Section {String(sectionIndex + 1)} of {String(sections.length)}
                </p>
                {/*
                  A section that has just been finished says so, once, where the
                  applicant is already looking. Not a badge that sits there from
                  the start - the transition from nothing to this is the signal.
                */}
                <AnimatePresence>
                  {complete ? (
                    <motion.span
                      className="inline-flex items-center gap-1 font-mono text-[0.625rem] tracking-[0.16em] text-xenon uppercase"
                      initial={{ opacity: 0, x: -4 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                    >
                      <Check className="size-3" strokeWidth={3} /> Complete
                    </motion.span>
                  ) : null}
                </AnimatePresence>
              </div>
              <h2 className="font-display text-xl font-bold text-ink">{section.title}</h2>
              {section.description === null ? null : (
                <p className="text-sm leading-relaxed text-ink-muted">{section.description}</p>
              )}
            </div>

            <div className="flex flex-col gap-7">
              {sectionQuestions.map((question) => (
                <div key={question.key} id={`question-${question.key}`} className="scroll-mt-24">
                  <QuestionField
                    question={question}
                    value={values[question.key]}
                    errors={showErrors ? errors[question.key] : undefined}
                    disabled={!editable}
                    characters={characters}
                    onChange={(next) => {
                      change(question.key, next);
                    }}
                  />
                </div>
              ))}
            </div>
          </section>
        );
      })}

      {editable ? (
        <Panel tone="raised" pad="lg" edgeLight className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <h2 className="font-display text-lg font-bold text-ink">Ready to submit?</h2>
            <p className="text-sm leading-relaxed text-ink-secondary">
              Once submitted you cannot edit unless a reviewer asks for changes. Your progress is
              already saved, so there is no rush.
            </p>
          </div>

          {!complete && showErrors ? (
            <div className="rounded-md border border-danger/30 bg-danger/5 p-4">
              <p className="text-sm font-medium text-danger">
                {Object.keys(errors).length} answer
                {Object.keys(errors).length === 1 ? '' : 's'} need attention
              </p>
              <ul className="mt-2 flex flex-col gap-1">
                {Object.entries(errors)
                  .slice(0, 5)
                  .map(([key, messages]) => {
                    const question = allQuestions.find((candidate) => candidate.key === key);
                    return (
                      <li key={key}>
                        <button
                          type="button"
                          onClick={() => {
                            document
                              .getElementById(`question-${key}`)
                              ?.scrollIntoView({ block: 'center' });
                          }}
                          className="text-left text-xs text-ink-secondary underline-offset-2 hover:underline"
                        >
                          {question?.label ?? key}: {messages[0]}
                        </button>
                      </li>
                    );
                  })}
              </ul>
            </div>
          ) : null}

          <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
            <Button
              variant="accent"
              size="lg"
              loading={submitting}
              onClick={() => {
                if (!complete) {
                  setShowErrors(true);
                  const firstKey = Object.keys(errors)[0];
                  if (firstKey !== undefined) {
                    document
                      .getElementById(`question-${firstKey}`)
                      ?.scrollIntoView({ block: 'center' });
                  }
                  return;
                }
                setConfirmOpen(true);
              }}
            >
              Submit application
            </Button>
          </div>
        </Panel>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Submit this application?"
        description={`${publicId} goes to the review team. You will not be able to edit it unless a reviewer asks for changes.`}
        confirmLabel="Submit"
        loading={submitting}
        onConfirm={submit}
      />
    </div>
  );
}

/**
 * The moment after submitting.
 *
 * One of the three or four things in this product that genuinely deserve
 * marking: a check drawing itself, a rail at its completion state, and the
 * reference the applicant will quote when they ask about it.
 *
 * No confetti. This is an administrative outcome with a real chance of being
 * rejected, and a burst of particles over it would cheapen both the moment and
 * the decision that follows.
 */
function SubmittedPanel({ publicId }: { publicId: string }): React.ReactElement {
  return (
    <Panel
      tone="raised"
      pad="lg"
      edgeLight
      className="flex flex-col items-center gap-5 py-14 text-center"
    >
      <SuccessCheck size={56} />

      <div className="flex flex-col gap-2">
        <h2 className="font-display text-title font-black text-ink uppercase">
          Application submitted
        </h2>
        <p className="text-sm text-ink-secondary">
          <span className="font-mono text-ink">{publicId}</span> is with the review team. You will
          be notified here and on Discord.
        </p>
      </div>

      {/* A completed rail rather than a decorative flourish: the form's progress
          indicator, at its end state, which is the last thing it has to say. */}
      <ProgressBar value={1} max={1} className="max-w-xs" label="Application complete" />
    </Panel>
  );
}

/** "just now" for the first half minute, then a clock time. */
function savedLabel(savedAt: Date, now: number): string {
  const seconds = Math.floor((now - savedAt.getTime()) / 1000);
  if (seconds < 5) return 'Saved';
  if (seconds < 60) return `Saved ${String(seconds)}s ago`;
  return `Saved at ${savedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * The save indicator.
 *
 * Visible at all times while editing, because the promise the form makes -
 * "your work is safe" - is only credible if the player can see it being kept.
 * A failure states what happened and offers a retry rather than quietly
 * flipping back to "saved".
 *
 * The states cross-fade rather than swap, and the icon changes with them: a
 * travelling rail while a request is in flight, a check that draws itself when
 * it lands. That sequence - working, then done - is the whole message, and it
 * is worth two hundred milliseconds of animation to make it legible at a
 * glance instead of a word that silently changes.
 */
function SaveIndicator({
  state,
  onRetry,
}: {
  state: { status: SaveStatus; savedAt: Date | null; errorMessage: string | null };
  onRetry: () => void;
}): React.ReactElement {
  /*
   * Queued and in-flight are shown as one state.
   *
   * The autosave marks itself dirty on the first keystroke and sends 1.2
   * seconds after typing stops, so the raw status flickers dirty → saving →
   * saved → dirty on every burst of typing. Rendering each of those is visual
   * noise attached to the one component whose job is to be quietly reassuring.
   *
   * Collapsing them leaves exactly one transition to look at - working, then
   * done - and "Saving…" is true in both: the answer is queued and going to the
   * server either way. An earlier attempt at this held "Unsaved changes" back
   * behind a timer instead, which was more code and could starve the display
   * indefinitely under a fast enough typist.
   */
  const phase: SaveStatus = state.status === 'dirty' ? 'saving' : state.status;
  const [now, setNow] = React.useState(() => Date.now());

  // The relative timestamp only moves while there is one to show.
  React.useEffect(() => {
    if (phase !== 'saved' || state.savedAt === null) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 5_000);
    return () => {
      clearInterval(timer);
    };
  }, [phase, state.savedAt]);

  const failed = phase === 'error' || phase === 'conflict';
  const working = phase === 'saving';

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'relative flex flex-wrap items-center gap-3 overflow-hidden rounded-md border px-4 py-2.5 text-xs',
        'transition-colors duration-(--duration-base) ease-standard',
        failed
          ? 'border-danger/40 bg-danger/5 text-danger'
          : working
            ? 'border-line-strong bg-elevated text-ink-secondary'
            : 'border-xenon/25 bg-xenon-deep/10 text-xenon',
      )}
    >
      {/* A real request is in flight: an indeterminate rail across the top of
          the strip, because nobody can know how long a round trip will take. */}
      {working ? (
        <LoadingRail className="absolute inset-x-0 top-0 rounded-none" label="Saving" />
      ) : null}

      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={phase}
          className="flex flex-1 flex-wrap items-center gap-3"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.16, ease: [0.32, 0.72, 0, 1] }}
        >
          {working ? (
            <>
              <Spinner className="size-3.5" label="Saving" />
              Saving…
            </>
          ) : phase === 'conflict' ? (
            <>
              <AlertTriangle className="size-3.5" aria-hidden />
              <span className="flex-1">{state.errorMessage}</span>
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  window.location.reload();
                }}
              >
                Reload
              </Button>
            </>
          ) : phase === 'error' ? (
            <>
              <CloudOff className="size-3.5" aria-hidden />
              <span className="flex-1">{state.errorMessage}</span>
              <Button variant="outline" size="sm" onClick={onRetry}>
                <RefreshCw /> Retry now
              </Button>
            </>
          ) : state.savedAt !== null ? (
            <>
              {/* A drawn check needs room for the stroke to read; at 14px it is
                  mush. The state change plus the colour is the signal here. */}
              <Check className="size-3.5" strokeWidth={3} aria-hidden />
              {savedLabel(state.savedAt, now)}
            </>
          ) : (
            <>
              <Check className="size-3.5" aria-hidden />
              Your progress saves automatically
            </>
          )}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}
