'use client';

import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import * as React from 'react';

import { cn } from '../lib/cn';

import { Button } from './button';

/**
 * Dialogs and sheets.
 *
 * Radix underneath because focus trapping, scroll locking, escape handling and
 * `aria-modal` are exactly the things a hand-rolled modal gets wrong, and they
 * are exactly the things that make a dialog unusable with a keyboard.
 *
 * `AlertDialog` is separate from `Dialog` on purpose: it cannot be dismissed by
 * clicking away, which is the correct behaviour for "reject this application"
 * and the wrong behaviour for a filter panel.
 */

const overlayClasses = cn(
  'fixed inset-0 z-[60] bg-void/80 backdrop-blur-sm',
  'data-[state=open]:animate-fade-in',
);

const panelClasses = cn(
  'fixed z-[70] flex flex-col gap-4 border border-line-strong bg-elevated p-6 shadow-float',
  'focus:outline-none',
);

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /** `sheet` slides from the right; used for filters and detail panes. */
    layout?: 'centre' | 'sheet';
    showClose?: boolean;
  }
>(function DialogContent(
  { className, children, layout = 'centre', showClose = true, ...props },
  ref,
) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={overlayClasses} />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          panelClasses,
          layout === 'centre'
            ? [
                'top-1/2 left-1/2 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl',
                'max-h-[calc(100dvh-4rem)] overflow-y-auto',
              ]
            : [
                // Full-height on mobile, a panel on desktop: a centred dialog on
                // a 375px screen is a dialog with no room in it.
                'inset-y-0 right-0 w-full max-w-md overflow-y-auto border-y-0 border-r-0 sm:rounded-l-xl',
              ],
          className,
        )}
        {...props}
      >
        {children}
        {showClose ? (
          <DialogPrimitive.Close
            className="absolute top-4 right-4 rounded-sm p-1.5 text-ink-muted transition-colors hover:bg-raised hover:text-ink"
            aria-label="Close"
          >
            <X className="size-4" />
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});

export function DialogHeader({
  title,
  description,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn('flex flex-col gap-1.5 pr-8', className)}>
      <DialogPrimitive.Title className="font-display text-xl font-bold tracking-tight text-ink">
        {title}
      </DialogPrimitive.Title>
      {description === undefined ? null : (
        <DialogPrimitive.Description className="text-sm leading-relaxed text-ink-secondary">
          {description}
        </DialogPrimitive.Description>
      )}
    </div>
  );
}

export function DialogFooter({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}>
      {children}
    </div>
  );
}

// --- Confirmation ------------------------------------------------------------

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'accent' | 'danger';
  loading?: boolean;
  onConfirm: () => void;
  /**
   * When set, the action is only enabled once the user types this exact string.
   * Reserved for genuinely irreversible operations.
   */
  confirmPhrase?: string;
}

/**
 * Confirmation for a consequential action.
 *
 * Used for approvals, rejections, revocations and deletions. The optional typed
 * phrase exists for the handful of operations that cannot be undone at all -
 * everywhere else it would be friction without a purpose, and friction people
 * learn to click through is worse than none.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'accent',
  loading = false,
  onConfirm,
  confirmPhrase,
}: ConfirmDialogProps): React.ReactElement {
  const [typed, setTyped] = React.useState('');
  const locked = confirmPhrase !== undefined && typed.trim() !== confirmPhrase;

  // Cleared as the dialog closes rather than from an effect on `open`: calling
  // setState inside an effect cascades a render, and the close handler is the
  // moment the reset actually belongs to.
  const handleOpenChange = (next: boolean): void => {
    if (!next) setTyped('');
    onOpenChange(next);
  };

  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className={overlayClasses} />
        <AlertDialogPrimitive.Content
          className={cn(
            panelClasses,
            'top-1/2 left-1/2 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl',
          )}
        >
          <AlertDialogPrimitive.Title className="font-display text-xl font-bold tracking-tight text-ink">
            {title}
          </AlertDialogPrimitive.Title>
          <AlertDialogPrimitive.Description asChild>
            <div className="text-sm leading-relaxed text-ink-secondary">{description}</div>
          </AlertDialogPrimitive.Description>

          {confirmPhrase === undefined ? null : (
            <label className="flex flex-col gap-2 text-sm">
              <span className="text-ink-secondary">
                Type <code className="font-mono text-xenon">{confirmPhrase}</code> to continue
              </span>
              <input
                value={typed}
                onChange={(event) => {
                  setTyped(event.target.value);
                }}
                className="h-10 rounded-md border border-line-strong bg-black px-3 font-mono text-sm text-ink focus-visible:border-xenon/60 focus-visible:ring-2 focus-visible:ring-xenon/25 focus-visible:outline-none"
                autoComplete="off"
              />
            </label>
          )}

          <DialogFooter>
            <AlertDialogPrimitive.Cancel asChild>
              <Button variant="ghost" disabled={loading}>
                {cancelLabel}
              </Button>
            </AlertDialogPrimitive.Cancel>
            <Button variant={tone} loading={loading} disabled={locked} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
