'use client';

import * as React from 'react';

import type { AnswerValue } from '@xenon/validation';

/**
 * Autosave.
 *
 * The single most important piece of client code in this product. A whitelist
 * application is forty minutes of writing, and the default failure mode of a
 * form that keeps its state in React is that a refresh, a crashed tab or a
 * closed laptop destroys all of it.
 *
 * The guarantees, and what provides each one:
 *
 *  - Nothing is ever held only in component state. Every edit is queued and
 *    flushed to the server within `DEBOUNCE_MS` of the typing stopping.
 *  - A save that fails is retried with backoff and the failure is visible. The
 *    dirty set is not cleared until the server confirms, so a failed save is
 *    resent rather than lost.
 *  - Closing the tab flushes synchronously through `keepalive`, which survives
 *    the document being torn down.
 *  - Leaving with unsaved work asks for confirmation.
 *  - Two tabs editing the same draft are detected by revision, not merged
 *    silently.
 */

const DEBOUNCE_MS = 1_200;
/** Backoff for a failed save. Capped so a long outage still retries steadily. */
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict';

export interface AutosaveState {
  readonly status: SaveStatus;
  readonly savedAt: Date | null;
  readonly revision: number;
  readonly errorMessage: string | null;
  /** True while anything is queued or in flight. Drives the leave warning. */
  readonly hasUnsaved: boolean;
}

export interface UseAutosaveResult extends AutosaveState {
  /** Record a change. Debounced; safe to call on every keystroke. */
  readonly change: (questionKey: string, value: AnswerValue) => void;
  /** Flush immediately, e.g. before submitting. Resolves when settled. */
  readonly flush: () => Promise<boolean>;
  /** Retry after a failure, from the retry button. */
  readonly retry: () => void;
  readonly values: AnswerValues;
}

/** Answers keyed by question key. Absent means the applicant has not answered. */
export type AnswerValues = Readonly<Record<string, AnswerValue | undefined>>;

interface SaveResponse {
  ok: boolean;
  revision?: number;
  savedAt?: string;
  message?: string;
  conflict?: boolean;
}

function toDraft(key: string, value: AnswerValue): Record<string, unknown> {
  return {
    questionKey: key,
    textValue: value.textValue ?? null,
    numberValue: value.numberValue ?? null,
    booleanValue: value.booleanValue ?? null,
    dateValue: typeof value.dateValue === 'string' ? value.dateValue : null,
    choiceValues: value.choiceValues === undefined ? undefined : [...value.choiceValues],
    mediaIds: value.mediaIds === undefined ? undefined : [...value.mediaIds],
  };
}

export function useAutosave(
  submissionId: string,
  initialRevision: number,
  initialValues: AnswerValues,
  options: { enabled: boolean } = { enabled: true },
): UseAutosaveResult {
  const [values, setValues] = React.useState(initialValues);
  const [state, setState] = React.useState<AutosaveState>({
    status: 'idle',
    savedAt: null,
    revision: initialRevision,
    errorMessage: null,
    hasUnsaved: false,
  });

  // Refs rather than state for everything the save loop reads: the loop must
  // see the latest values without being re-created on every keystroke.
  const valuesRef = React.useRef(initialValues);
  const dirtyRef = React.useRef(new Set<string>());
  const revisionRef = React.useRef(initialRevision);
  const inFlightRef = React.useRef(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = React.useRef(0);

  const save = React.useCallback(async (): Promise<boolean> => {
    if (!options.enabled) return true;
    if (inFlightRef.current) return false;
    if (dirtyRef.current.size === 0) return true;

    // Snapshot the dirty keys. Anything edited while this request is in flight
    // stays dirty and is picked up by the next pass.
    const keys = [...dirtyRef.current];
    inFlightRef.current = true;
    setState((current) => ({ ...current, status: 'saving', errorMessage: null }));

    try {
      const response = await fetch('/api/portal/autosave', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          submissionId,
          revision: revisionRef.current,
          answers: keys.map((key) => toDraft(key, valuesRef.current[key] ?? {})),
        }),
      });

      const body = (await response.json()) as SaveResponse;

      if (!response.ok || !body.ok) {
        inFlightRef.current = false;

        if (body.conflict === true) {
          // Not retryable: another tab or device holds a newer revision, and
          // resending would overwrite work the player can still see.
          setState((current) => ({
            ...current,
            status: 'conflict',
            errorMessage: body.message ?? 'This application was edited somewhere else.',
            hasUnsaved: true,
          }));
          return false;
        }

        setState((current) => ({
          ...current,
          status: 'error',
          errorMessage: body.message ?? 'Could not save. Retrying.',
          hasUnsaved: true,
        }));
        return false;
      }

      // Only now is it safe to forget these keys.
      for (const key of keys) dirtyRef.current.delete(key);
      revisionRef.current = body.revision ?? revisionRef.current + 1;
      attemptRef.current = 0;
      inFlightRef.current = false;

      const stillDirty = dirtyRef.current.size > 0;
      setState({
        status: stillDirty ? 'dirty' : 'saved',
        savedAt: body.savedAt === undefined ? new Date() : new Date(body.savedAt),
        revision: revisionRef.current,
        errorMessage: null,
        hasUnsaved: stillDirty,
      });

      return !stillDirty;
    } catch {
      inFlightRef.current = false;
      setState((current) => ({
        ...current,
        status: 'error',
        errorMessage: 'You appear to be offline. Your answers are kept and will be retried.',
        hasUnsaved: true,
      }));
      return false;
    }
  }, [submissionId, options.enabled]);

  /**
   * Schedule a save, replacing any pending one.
   *
   * The retry path re-schedules itself, and a `useCallback` cannot reference
   * its own binding while it is being defined. Routing the recursion through a
   * ref keeps the backoff loop without a stale-closure hazard.
   */
  const scheduleRef = React.useRef<(delay: number) => void>(() => undefined);

  const schedule = React.useCallback((delay: number) => {
    scheduleRef.current(delay);
  }, []);

  React.useEffect(() => {
    scheduleRef.current = (delay: number) => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        void save().then((settled) => {
          if (settled) return;
          // Failed or partially settled: back off and try again.
          const index = Math.min(attemptRef.current, RETRY_DELAYS_MS.length - 1);
          attemptRef.current += 1;
          scheduleRef.current(RETRY_DELAYS_MS[index] ?? 30_000);
        });
      }, delay);
    };
  }, [save]);

  const change = React.useCallback(
    (questionKey: string, value: AnswerValue) => {
      valuesRef.current = { ...valuesRef.current, [questionKey]: value };
      setValues(valuesRef.current);
      dirtyRef.current.add(questionKey);

      setState((current) =>
        // A conflict is sticky: the player has to reload, and pretending a new
        // keystroke resolved it would lose their work on the next save.
        current.status === 'conflict' ? current : { ...current, status: 'dirty', hasUnsaved: true },
      );

      schedule(DEBOUNCE_MS);
    },
    [schedule],
  );

  const flush = React.useCallback(async (): Promise<boolean> => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    return save();
  }, [save]);

  const retry = React.useCallback(() => {
    attemptRef.current = 0;
    schedule(0);
  }, [schedule]);

  /**
   * Last-gasp flush.
   *
   * `pagehide` fires on a real close, a back-forward navigation and on mobile
   * when the tab is backgrounded - which `beforeunload` does not reliably do
   * on iOS. `keepalive` lets the request outlive the document.
   */
  React.useEffect(() => {
    if (!options.enabled) return;

    const flushBeacon = (): void => {
      if (dirtyRef.current.size === 0) return;

      const body = JSON.stringify({
        submissionId,
        revision: revisionRef.current,
        answers: [...dirtyRef.current].map((key) => toDraft(key, valuesRef.current[key] ?? {})),
      });

      void fetch('/api/portal/autosave', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => undefined);
    };

    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flushBeacon();
    };

    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (dirtyRef.current.size === 0) return;
      flushBeacon();
      // The browser shows its own generic message; the string is ignored, but
      // preventDefault is what triggers the prompt at all.
      event.preventDefault();
    };

    window.addEventListener('pagehide', flushBeacon);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      window.removeEventListener('pagehide', flushBeacon);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [submissionId, options.enabled]);

  return { ...state, change, flush, retry, values };
}
