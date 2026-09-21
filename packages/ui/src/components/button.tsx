'use client';

import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import * as React from 'react';

import { cn } from '../lib/cn';

/**
 * Button.
 *
 * Five intents, and only one of them is green. The accent variant is the
 * primary action on a screen - Apply, Approve, Enter the city - and using it
 * twice in one view means one of them is not actually primary.
 *
 * Motion is a 1px translate on press, not a scale bounce: it should read as a
 * physical key travelling, which is the difference between "engineered" and
 * "toy".
 */
const buttonVariants = cva(
  [
    'relative inline-flex items-center justify-center gap-2 whitespace-nowrap',
    'font-medium select-none',
    'transition-[background-color,border-color,color,box-shadow,transform] duration-(--duration-fast) ease-standard',
    'disabled:pointer-events-none disabled:opacity-40',
    'active:translate-y-px',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        accent: [
          'bg-xenon text-ink-inverse font-semibold',
          'hover:bg-xenon-bright',
          'shadow-[0_0_0_1px_var(--color-xenon-dim),0_8px_24px_-12px_#2afd2399]',
        ],
        solid: ['bg-chrome-100 text-ink-inverse font-semibold', 'hover:bg-white'],
        outline: [
          'border border-line-strong bg-transparent text-ink',
          'hover:border-chrome-400 hover:bg-elevated',
        ],
        ghost: ['bg-transparent text-ink-secondary', 'hover:bg-elevated hover:text-ink'],
        danger: [
          'bg-danger/12 border border-danger/40 text-danger',
          'hover:bg-danger hover:text-ink-inverse hover:border-danger',
        ],
        link: ['bg-transparent text-xenon underline-offset-4 hover:underline p-0 h-auto'],
      },
      size: {
        sm: 'h-8 rounded-sm px-3 text-[0.8125rem] [&_svg]:size-3.5',
        md: 'h-10 rounded-md px-4 text-sm [&_svg]:size-4',
        lg: 'h-12 rounded-md px-6 text-[0.9375rem] [&_svg]:size-4',
        xl: 'h-14 rounded-md px-9 text-base tracking-tight [&_svg]:size-5',
        icon: 'size-9 rounded-md [&_svg]:size-4',
      },
    },
    defaultVariants: { variant: 'outline', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Render as the child element, e.g. a Next `<Link>`, keeping the styling. */
  asChild?: boolean;
  /** Shows a spinner and blocks interaction. */
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, loading = false, children, disabled, ...props },
  ref,
) {
  const Component = asChild ? Slot : 'button';

  return (
    <Component
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled === true || loading}
      // Announced to assistive technology, which a spinner alone is not.
      aria-busy={loading || undefined}
      {...props}
    >
      {/*
        `asChild` hands the child straight to Radix's Slot, which requires
        exactly one element. Wrapping it alongside a spinner - even a null one -
        gives Slot two children and it refuses at render time. A link rendered
        through `asChild` has no loading state to show anyway, so the spinner is
        simply not part of that branch.
      */}
      {asChild ? (
        children
      ) : (
        <>
          {loading ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {children}
        </>
      )}
    </Component>
  );
});

export { buttonVariants };
