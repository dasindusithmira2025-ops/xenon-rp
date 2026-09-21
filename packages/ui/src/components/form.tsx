'use client';

import * as LabelPrimitive from '@radix-ui/react-label';
import * as React from 'react';

import { cn } from '../lib/cn';

/**
 * Form controls.
 *
 * Every control is styled from the same three ingredients - a sunken surface,
 * a hairline border and a green focus ring - so a long application form reads
 * as one instrument rather than a pile of widgets.
 *
 * Errors are wired through `aria-describedby` and `aria-invalid` rather than
 * being red text that happens to sit nearby, because a screen-reader user
 * filling in a forty-minute form needs to know which field is wrong.
 */

const fieldBase = [
  'w-full rounded-md border bg-black px-3 text-ink',
  'placeholder:text-ink-muted/70',
  'transition-[border-color,box-shadow] duration-(--duration-fast) ease-standard',
  'focus:outline-none focus-visible:border-xenon/60 focus-visible:ring-2 focus-visible:ring-xenon/25',
  'disabled:cursor-not-allowed disabled:opacity-50',
  'aria-[invalid=true]:border-danger/70 aria-[invalid=true]:ring-danger/20',
].join(' ');

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(fieldBase, 'h-10 border-line-strong text-sm', className)}
      {...props}
    />
  );
});

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Grow with the content instead of scrolling inside a fixed box. */
  autoGrow?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, autoGrow = false, onChange, ...props },
  ref,
) {
  const inner = React.useRef<HTMLTextAreaElement | null>(null);

  const resize = React.useCallback(() => {
    const element = inner.current;
    if (element === null || !autoGrow) return;
    element.style.height = 'auto';
    element.style.height = `${String(element.scrollHeight)}px`;
  }, [autoGrow]);

  // Resize once on mount so a restored draft opens at its full height rather
  // than snapping open after the first keystroke.
  React.useEffect(resize, [resize, props.value]);

  return (
    <textarea
      ref={(node) => {
        inner.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref !== null) ref.current = node;
      }}
      onChange={(event) => {
        resize();
        onChange?.(event);
      }}
      className={cn(
        fieldBase,
        'min-h-28 resize-y border-line-strong py-2.5 text-sm leading-relaxed',
        autoGrow && 'resize-none overflow-hidden',
        className,
      )}
      {...props}
    />
  );
});

export const Label = React.forwardRef<
  React.ComponentRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> & { required?: boolean }
>(function Label({ className, required = false, children, ...props }, ref) {
  return (
    <LabelPrimitive.Root
      ref={ref}
      className={cn('text-sm font-medium text-ink', className)}
      {...props}
    >
      {children}
      {required ? (
        <span className="ml-1 text-xenon" aria-hidden>
          *
        </span>
      ) : null}
    </LabelPrimitive.Root>
  );
});

export interface FieldProps {
  label?: React.ReactNode;
  htmlFor?: string;
  required?: boolean;
  hint?: React.ReactNode;
  error?: string | readonly string[] | null;
  children: React.ReactNode;
  className?: string;
  /** Right-aligned counter or status, e.g. "412 / 2000". */
  meta?: React.ReactNode;
}

/**
 * Label, control, hint and error as one unit.
 *
 * The accessible wiring lives here so no individual form gets it wrong: the
 * hint and the error are both referenced by the control, and the error is a
 * live region so it is announced when it appears rather than only when the
 * field is next focused.
 */
export function Field({
  label,
  htmlFor,
  required = false,
  hint,
  error,
  children,
  className,
  meta,
}: FieldProps): React.ReactElement {
  const messages = error == null ? [] : typeof error === 'string' ? [error] : [...error];
  const hasError = messages.length > 0;

  const hintId = htmlFor === undefined ? undefined : `${htmlFor}-hint`;
  const errorId = htmlFor === undefined ? undefined : `${htmlFor}-error`;

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {label === undefined ? null : (
        <div className="flex items-baseline justify-between gap-3">
          <Label htmlFor={htmlFor} required={required}>
            {label}
          </Label>
          {meta === undefined ? null : (
            <span className="x-tabular text-xs text-ink-muted">{meta}</span>
          )}
        </div>
      )}

      {hint === undefined ? null : (
        <p id={hintId} className="text-xs leading-relaxed text-ink-muted">
          {hint}
        </p>
      )}

      {React.isValidElement(children)
        ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
            id: htmlFor,
            'aria-invalid': hasError || undefined,
            'aria-describedby':
              [hint === undefined ? null : hintId, hasError ? errorId : null]
                .filter((value): value is string => typeof value === 'string')
                .join(' ') || undefined,
          })
        : children}

      {hasError ? (
        <p id={errorId} role="alert" className="text-xs font-medium text-danger">
          {messages.join(' ')}
        </p>
      ) : null}
    </div>
  );
}

// --- Native select -----------------------------------------------------------

/**
 * Select.
 *
 * The native element rather than a Radix listbox. On a phone it opens the OS
 * picker, which is faster and more accessible than anything reimplemented, and
 * this form has dozens of them. Radix is used where the native control cannot
 * do the job - dialogs, menus, comboboxes.
 */
export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, children, ...props }, ref) {
  return (
    <div className="relative">
      <select
        ref={ref}
        className={cn(
          fieldBase,
          'h-10 cursor-pointer appearance-none border-line-strong pr-9 text-sm',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <svg
        className="pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-ink-muted"
        viewBox="0 0 12 12"
        fill="none"
        aria-hidden
      >
        <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    </div>
  );
});

// --- Checkbox and radio ------------------------------------------------------

export interface ChoiceProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: React.ReactNode;
  hint?: React.ReactNode;
}

/**
 * Checkbox and radio as a single tappable card.
 *
 * A bare 16px control is a poor target on a phone and gives no feedback for the
 * label text beside it. Wrapping the whole row means the entire option is the
 * hit area, which is what the form actually needs.
 */
export function Choice({
  label,
  hint,
  className,
  type = 'checkbox',
  ...props
}: ChoiceProps): React.ReactElement {
  return (
    <label
      className={cn(
        'group flex cursor-pointer items-start gap-3 rounded-md border border-line-strong bg-black p-3',
        'transition-colors duration-(--duration-fast)',
        'hover:border-chrome-500 has-[:checked]:border-xenon/50 has-[:checked]:bg-xenon-deep/15',
        'has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50',
        className,
      )}
    >
      <input
        type={type}
        className={cn(
          'mt-0.5 size-4 shrink-0 cursor-pointer appearance-none border border-chrome-500 bg-black',
          type === 'radio' ? 'rounded-full' : 'rounded-xs',
          'checked:border-xenon checked:bg-xenon',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-xenon',
          "checked:after:block checked:after:size-full checked:after:content-['']",
          type === 'checkbox' &&
            "checked:after:[background:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none'%3E%3Cpath d='M3.5 8.5l3 3 6-6' stroke='%23050705' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")_center/contain_no-repeat]",
          type === 'radio' &&
            'checked:after:scale-[0.45] checked:after:rounded-full checked:after:bg-ink-inverse',
        )}
        {...props}
      />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-sm leading-snug text-ink">{label}</span>
        {hint === undefined ? null : <span className="text-xs text-ink-muted">{hint}</span>}
      </span>
    </label>
  );
}

// --- Switch ------------------------------------------------------------------

export function Switch({
  checked,
  onCheckedChange,
  disabled = false,
  label,
  id,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
  id?: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        onCheckedChange(!checked);
      }}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-pill border transition-colors duration-(--duration-fast)',
        checked ? 'border-xenon bg-xenon' : 'border-chrome-500 bg-elevated',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span
        className={cn(
          'block size-3.5 rounded-full transition-transform duration-(--duration-fast) ease-standard',
          checked ? 'translate-x-[1.125rem] bg-ink-inverse' : 'translate-x-0.5 bg-chrome-300',
        )}
      />
    </button>
  );
}
