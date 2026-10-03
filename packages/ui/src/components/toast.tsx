'use client';

import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import * as React from 'react';

import { cn } from '../lib/cn';

/**
 * Toasts.
 *
 * The house alternative to `window.alert`, which is banned by lint for good
 * reason: it blocks the event loop, cannot be styled, and on a page driven by
 * server actions it interrupts the very navigation that produced it.
 *
 * Deliberately small and dependency-free. A toast is a list, a timer and a
 * live region; a library for that is more configuration surface than code.
 *
 * Each toast owns its own countdown rather than the provider owning all of
 * them, which is what makes "pause while the pointer is on it" possible: the
 * timer and the bar that visualises it are the same piece of state, held next
 * to the element they belong to.
 */

export type ToastTone = 'success' | 'error' | 'warning' | 'info';

export interface ToastOptions {
  readonly title: string;
  readonly description?: string;
  readonly tone?: ToastTone;
  readonly durationMs?: number;
  readonly action?: { label: string; onClick: () => void };
}

interface ToastRecord extends ToastOptions {
  readonly id: number;
}

interface ToastApi {
  toast: (options: ToastOptions) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  dismiss: (id: number) => void;
}

const ToastContext = React.createContext<ToastApi | null>(null);

/** Access the toast API. Throws when used outside the provider, which is a bug. */
export function useToast(): ToastApi {
  const context = React.useContext(ToastContext);
  if (context === null) {
    throw new Error('useToast must be used inside <ToastProvider>');
  }
  return context;
}

const toneStyles: Record<ToastTone, { border: string; bar: string; icon: React.ReactNode }> = {
  success: {
    border: 'border-l-xenon',
    bar: 'bg-xenon',
    icon: <CheckCircle2 className="size-4 text-xenon" />,
  },
  error: {
    border: 'border-l-danger',
    bar: 'bg-danger',
    icon: <XCircle className="size-4 text-danger" />,
  },
  warning: {
    border: 'border-l-warning',
    bar: 'bg-warning',
    icon: <AlertTriangle className="size-4 text-warning" />,
  },
  info: { border: 'border-l-info', bar: 'bg-info', icon: <Info className="size-4 text-info" /> },
};

export function ToastProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [toasts, setToasts] = React.useState<readonly ToastRecord[]>([]);
  const nextId = React.useRef(0);

  const dismiss = React.useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const toast = React.useCallback((options: ToastOptions) => {
    const id = (nextId.current += 1);
    setToasts((current) => [...current.slice(-3), { ...options, id }]);
  }, []);

  const api = React.useMemo<ToastApi>(
    () => ({
      toast,
      dismiss,
      success: (title, description) => {
        toast({ title, description, tone: 'success' });
      },
      error: (title, description) => {
        toast({ title, description, tone: 'error' });
      },
    }),
    [toast, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}

      <div
        // `polite` rather than `assertive`: a toast should not interrupt
        // whatever a screen reader is currently saying mid-sentence.
        role="status"
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-80 flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:right-0 sm:items-end"
      >
        <AnimatePresence initial={false}>
          {toasts.map((item) => (
            <ToastItem key={item.id} toast={item} onDismiss={dismiss} />
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: ToastRecord;
  onDismiss: (id: number) => void;
}): React.ReactElement {
  const reduced = useReducedMotion();
  const tone = toneStyles[toast.tone ?? 'info'];

  // Errors stay until dismissed. An error that vanishes after four seconds is
  // an error the user never read.
  const duration = toast.durationMs ?? (toast.tone === 'error' ? 0 : 5_000);

  const [paused, setPaused] = React.useState(false);
  const remainingRef = React.useRef(duration);
  const startedRef = React.useRef(0);

  const { id } = toast;

  /*
   * The countdown.
   *
   * A real timer rather than the bar's `animationend`, even though the two are
   * showing the same thing. Under `prefers-reduced-motion` the base stylesheet
   * flattens every animation to a thousandth of a millisecond, so a toast whose
   * dismissal hung off the animation would disappear the instant it appeared -
   * the accessibility preference would silently become a "never show me
   * anything" preference.
   */
  React.useEffect(() => {
    if (duration <= 0 || paused) return;

    startedRef.current = Date.now();
    const timer = setTimeout(() => {
      onDismiss(id);
    }, remainingRef.current);

    return () => {
      clearTimeout(timer);
      // Banked on the way out, so resuming continues rather than restarts.
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedRef.current));
    };
  }, [duration, paused, id, onDismiss]);

  const hold = React.useCallback(() => {
    setPaused(true);
  }, []);
  const release = React.useCallback(() => {
    setPaused(false);
  }, []);

  return (
    <motion.div
      layout={reduced !== true}
      initial={reduced === true ? false : { opacity: 0, y: 16, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.98, transition: { duration: 0.15 } }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      // Pointer and keyboard both pause it. Someone tabbing to the action
      // button has exactly the same need as someone reaching for it with a
      // mouse, and is more likely to be slower.
      onHoverStart={hold}
      onHoverEnd={release}
      onFocusCapture={hold}
      onBlurCapture={release}
      className={cn(
        'pointer-events-auto relative flex w-full max-w-sm items-start gap-3 overflow-hidden rounded-lg border border-line-strong border-l-2 bg-overlay p-3.5 shadow-float',
        tone.border,
      )}
    >
      <span className="mt-0.5 shrink-0">{tone.icon}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-sm font-medium text-ink">{toast.title}</p>
        {toast.description === undefined ? null : (
          <p className="text-xs leading-relaxed text-ink-secondary">{toast.description}</p>
        )}
        {toast.action === undefined ? null : (
          <button
            type="button"
            onClick={() => {
              toast.action?.onClick();
              onDismiss(id);
            }}
            className="mt-1 self-start text-xs font-semibold text-xenon underline-offset-4 hover:underline"
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={() => {
          onDismiss(id);
        }}
        aria-label="Dismiss"
        className="shrink-0 rounded-sm p-1 text-ink-muted transition-colors hover:bg-raised hover:text-ink"
      >
        <X className="size-3.5" />
      </button>

      {/*
        The countdown, made visible.

        A toast that vanishes without warning feels like a bug; a bar draining
        along the bottom edge turns the same disappearance into something the
        reader saw coming and could stop. Driven by a CSS animation so it costs
        nothing, and paused in lockstep with the timer above.

        Toasts that never expire have nothing to count down, and get no bar.
      */}
      {duration > 0 ? (
        <span
          aria-hidden
          className={cn('x-toast-timer absolute inset-x-0 bottom-0 h-0.5 origin-left', tone.bar)}
          style={{
            animationDuration: `${String(duration)}ms`,
            animationPlayState: paused ? 'paused' : 'running',
          }}
        />
      ) : null}
    </motion.div>
  );
}
