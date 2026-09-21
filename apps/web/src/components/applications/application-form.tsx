'use client';

import { AlertTriangle, Check, CloudOff, Loader2, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import type { RenderableSection } from '@xenon/applications';
import { Button, cn, ConfirmDialog, Panel, Progress, useToast } from '@xenon/ui';
import { submissionProgress, validateSubmission, visibleQuestions } from '@xenon/validation';

import { QuestionField } from './question-field';
import { type AnswerValues, useAutosave } from './use-autosave';

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
        toast.success('Application submitted', `${publicId} is now with the review team.`);
        setConfirmOpen(false);
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

      <Panel tone="flat" pad="lg" className="sticky top-4 z-[20] backdrop-blur-sm">
        <div className="flex items-baseline justify-between gap-4">
          <p className="text-sm font-medium text-ink">{templateName}</p>
          <p className="x-tabular font-mono text-xs text-ink-muted">
            {progress.answered} / {progress.total} required
          </p>
        </div>
        <Progress
          value={progress.answered}
          max={Math.max(progress.total, 1)}
          className="mt-3"
          label="Application progress"
        />
      </Panel>

      {sections.map((section, sectionIndex) => {
        const sectionQuestions = section.questions.filter((question) => visible.has(question.key));
        if (sectionQuestions.length === 0) return null;

        return (
          <section key={section.id} className="flex flex-col gap-6">
            <div className="flex flex-col gap-2 border-b border-line pb-4">
              <p className="x-eyebrow">
                Section {String(sectionIndex + 1)} of {String(sections.length)}
              </p>
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
 * The save indicator.
 *
 * Visible at all times while editing, because the promise the form makes -
 * "your work is safe" - is only credible if the player can see it being kept.
 * A failure states what happened and offers a retry rather than quietly
 * flipping back to "saved".
 */
function SaveIndicator({
  state,
  onRetry,
}: {
  state: { status: string; savedAt: Date | null; errorMessage: string | null };
  onRetry: () => void;
}): React.ReactElement {
  const tone =
    state.status === 'error' || state.status === 'conflict'
      ? 'border-danger/40 bg-danger/5 text-danger'
      : state.status === 'saving' || state.status === 'dirty'
        ? 'border-line-strong bg-elevated text-ink-secondary'
        : 'border-xenon/25 bg-xenon-deep/10 text-xenon';

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex flex-wrap items-center gap-3 rounded-md border px-4 py-2.5 text-xs',
        tone,
      )}
    >
      {state.status === 'saving' ? (
        <>
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          Saving…
        </>
      ) : state.status === 'dirty' ? (
        <>
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          Unsaved changes
        </>
      ) : state.status === 'conflict' ? (
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
      ) : state.status === 'error' ? (
        <>
          <CloudOff className="size-3.5" aria-hidden />
          <span className="flex-1">{state.errorMessage}</span>
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw /> Retry now
          </Button>
        </>
      ) : state.savedAt !== null ? (
        <>
          <Check className="size-3.5" aria-hidden />
          Saved at{' '}
          {state.savedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
        </>
      ) : (
        <>
          <Check className="size-3.5" aria-hidden />
          Your progress saves automatically
        </>
      )}
    </div>
  );
}
