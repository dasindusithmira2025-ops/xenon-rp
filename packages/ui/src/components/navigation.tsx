'use client';

import * as AccordionPrimitive from '@radix-ui/react-accordion';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { ChevronDown } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import * as React from 'react';

import { cn } from '../lib/cn';

/**
 * Menus, tabs, disclosure and tooltips.
 *
 * All four are keyboard interactions before they are visual ones, so all four
 * are Radix with Xenon styling rather than divs with click handlers.
 */

// --- Dropdown menu -----------------------------------------------------------

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuSeparator = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(function DropdownMenuSeparator({ className, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Separator
      ref={ref}
      className={cn('-mx-1 my-1 h-px bg-line', className)}
      {...props}
    />
  );
});

export const DropdownMenuContent = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(function DropdownMenuContent({ className, sideOffset = 6, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          'z-70 min-w-48 overflow-hidden rounded-lg border border-line-strong bg-elevated p-1 shadow-float',
          // Radix sets the transform origin to the side the menu opened from,
          // so the scale reads as the menu growing out of its trigger rather
          // than inflating in place.
          'origin-(--radix-dropdown-menu-content-transform-origin)',
          'data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
});

export const DropdownMenuItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & { danger?: boolean }
>(function DropdownMenuItem({ className, danger = false, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Item
      ref={ref}
      className={cn(
        'flex cursor-pointer items-center gap-2.5 rounded-sm px-2.5 py-2 text-sm outline-none select-none',
        'data-[highlighted]:bg-raised data-[disabled]:pointer-events-none data-[disabled]:opacity-40',
        danger
          ? 'text-danger data-[highlighted]:bg-danger/12'
          : 'text-ink-secondary data-[highlighted]:text-ink',
        '[&_svg]:size-4 [&_svg]:shrink-0',
        className,
      )}
      {...props}
    />
  );
});

export function DropdownMenuLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return <div className={cn('x-eyebrow px-2.5 py-2', className)}>{children}</div>;
}

// --- Tooltip -----------------------------------------------------------------

export const TooltipProvider = TooltipPrimitive.Provider;

/**
 * Tooltip.
 *
 * Supplementary detail only. Anything a user must read to complete a task is
 * hint text under the field, because a tooltip is unreachable on touch and
 * fiddly with a keyboard.
 */
export function Tooltip({
  content,
  children,
  side = 'top',
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
}): React.ReactElement {
  return (
    <TooltipPrimitive.Root delayDuration={250}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-70 max-w-64 origin-(--radix-tooltip-content-transform-origin) rounded-md border border-line-strong bg-overlay px-2.5 py-1.5 text-xs leading-relaxed text-ink shadow-float data-[state=closed]:animate-fade-out data-[state=delayed-open]:animate-scale-in"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

// --- Tabs --------------------------------------------------------------------

/**
 * The active tab's underline, shared between triggers.
 *
 * Radix does not publish the selected value to descendants, so this context
 * carries it the short distance from the root to the triggers. That is the only
 * reason `Tabs` is a component here rather than a re-export: a single element
 * with a `layoutId` can only exist under the active trigger, and the trigger
 * has to know that it is the active one to render it.
 *
 * The id is per-instance. Two tab strips on one page sharing a `layoutId` would
 * animate the underline across the gap between them, which looks like a bug
 * because it is one.
 */
const TabsContext = React.createContext<{ value: string | undefined; id: string }>({
  value: undefined,
  id: 'tabs',
});

export function Tabs({
  value,
  defaultValue,
  onValueChange,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root>): React.ReactElement {
  const id = React.useId();
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue);
  const current = value ?? uncontrolled;

  const handleValueChange = React.useCallback(
    (next: string) => {
      setUncontrolled(next);
      onValueChange?.(next);
    },
    [onValueChange],
  );

  const context = React.useMemo(() => ({ value: current, id }), [current, id]);

  return (
    <TabsContext.Provider value={context}>
      <TabsPrimitive.Root
        value={value}
        defaultValue={defaultValue}
        onValueChange={handleValueChange}
        {...props}
      />
    </TabsContext.Provider>
  );
}

export const TabsList = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(function TabsList({ className, ...props }, ref) {
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn(
        // Horizontal scroll rather than wrapping: a tab strip that becomes two
        // rows on a phone stops reading as a tab strip.
        'relative flex items-center gap-1 overflow-x-auto border-b border-line',
        '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
      {...props}
    />
  );
});

export const TabsTrigger = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(function TabsTrigger({ className, children, ...props }, ref) {
  const { value, id } = React.useContext(TabsContext);
  const reduced = useReducedMotion();
  const active = value !== undefined && value === props.value;

  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        'relative -mb-px shrink-0 px-3.5 py-2.5 text-sm font-medium whitespace-nowrap',
        'text-ink-muted transition-colors duration-(--duration-fast)',
        'hover:text-ink-secondary',
        'data-[state=active]:text-ink',
        className,
      )}
      {...props}
    >
      {children}
      {/*
        One underline, moved - not four, toggled. The distinction is the whole
        point: an indicator that slides carries the eye from the old tab to the
        new one, which is a statement about where you just came from. An
        indicator that disappears and reappears is a light switch.

        Reduced motion keeps the underline and drops the travel, so the active
        tab is still unambiguous.
      */}
      {active ? (
        <motion.span
          layoutId={reduced === true ? undefined : `${id}-tab-underline`}
          className="absolute inset-x-0 bottom-0 h-0.5 bg-xenon"
          transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
        />
      ) : null}
    </TabsPrimitive.Trigger>
  );
});

export const TabsContent = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(function TabsContent({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Content
      ref={ref}
      // Fast and small. Tab content is usually a form or a table, and a long
      // entrance on something the user is about to read or type into is a
      // delay wearing a costume.
      className={cn('data-[state=active]:animate-tab-in focus-visible:outline-none', className)}
      {...props}
    />
  );
});

// --- Accordion ---------------------------------------------------------------

export const Accordion = AccordionPrimitive.Root;

export const AccordionItem = React.forwardRef<
  React.ComponentRef<typeof AccordionPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Item>
>(function AccordionItem({ className, ...props }, ref) {
  return (
    <AccordionPrimitive.Item
      ref={ref}
      className={cn('border-b border-line', className)}
      {...props}
    />
  );
});

export const AccordionTrigger = React.forwardRef<
  React.ComponentRef<typeof AccordionPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Trigger>
>(function AccordionTrigger({ className, children, ...props }, ref) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        ref={ref}
        className={cn(
          'group flex flex-1 items-center justify-between gap-4 py-4 text-left text-base font-medium text-ink',
          'transition-colors hover:text-xenon',
          className,
        )}
        {...props}
      >
        {children}
        <ChevronDown className="size-4 shrink-0 text-ink-muted transition-transform duration-(--duration-base) ease-standard group-data-[state=open]:rotate-180" />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
});

export const AccordionContent = React.forwardRef<
  React.ComponentRef<typeof AccordionPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Content>
>(function AccordionContent({ className, children, ...props }, ref) {
  return (
    <AccordionPrimitive.Content
      ref={ref}
      className="overflow-hidden data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down"
      {...props}
    >
      <div className={cn('pb-5 text-sm leading-relaxed text-ink-secondary', className)}>
        {children}
      </div>
    </AccordionPrimitive.Content>
  );
});
