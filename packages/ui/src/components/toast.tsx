'use client';

import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
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

const toneStyles: Record<ToastTone, { border: string; icon: React.ReactNode }> = {
  success: {
    border: 'border-l-xenon',
    icon: <CheckCircle2 className="size-4 text-xenon" />,
  },
  error: { border: 'border-l-danger', icon: <XCircle className="size-4 text-danger" /> },
  warning: {
    border: 'border-l-warning',
    icon: <AlertTriangle className="size-4 text-warning" />,
  },
  info: { border: 'border-l-info', icon: <Info className="size-4 text-info" /> },
};

export function ToastProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [toasts, setToasts] = React.useState<readonly ToastRecord[]>([]);
  const nextId = React.useRef(0);

  const dismiss = React.useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const toast = React.useCallback(
    (options: ToastOptions) => {
      const id = (nextId.current += 1);
      setToasts((current) => [...current.slice(-3), { ...options, id }]);

      // Errors stay until dismissed. An error that vanishes after four seconds
      // is an error the user never read.
      const duration = options.durationMs ?? (options.tone === 'error' ? 0 : 5_000);
      if (duration > 0) {
        setTimeout(() => {
          dismiss(id);
        }, duration);
      }
    },
    [dismiss],
  );

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
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[80] flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:right-0 sm:items-end"
      >
        {toasts.map((item) => {
          const tone = toneStyles[item.tone ?? 'info'];
          return (
            <div
              key={item.id}
              className={cn(
                'pointer-events-auto flex w-full max-w-sm animate-slide-up items-start gap-3 rounded-lg border border-line-strong border-l-2 bg-overlay p-3.5 shadow-float',
                tone.border,
              )}
            >
              <span className="mt-0.5 shrink-0">{tone.icon}</span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="text-sm font-medium text-ink">{item.title}</p>
                {item.description === undefined ? null : (
                  <p className="text-xs leading-relaxed text-ink-secondary">{item.description}</p>
                )}
                {item.action === undefined ? null : (
                  <button
                    type="button"
                    onClick={() => {
                      item.action?.onClick();
                      dismiss(item.id);
                    }}
                    className="mt-1 self-start text-xs font-semibold text-xenon underline-offset-4 hover:underline"
                  >
                    {item.action.label}
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  dismiss(item.id);
                }}
                aria-label="Dismiss"
                className="shrink-0 rounded-sm p-1 text-ink-muted transition-colors hover:bg-raised hover:text-ink"
              >
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
