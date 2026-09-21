import { cn, Eyebrow } from '@xenon/ui';
import { Reveal } from '@xenon/ui/motion';

/**
 * Page section scaffolding.
 *
 * Three pieces the whole public site is built from: a vertically rhythmic
 * section, an editorial heading block, and a page header for the non-hero
 * routes. Centralising the rhythm is what stops fourteen pages each inventing
 * their own vertical spacing and the site reading as fourteen sites.
 */

export function Section({
  children,
  className,
  width = 'content',
  tone = 'void',
  id,
  size = 'md',
}: {
  children: React.ReactNode;
  className?: string;
  width?: 'content' | 'wide' | 'full';
  tone?: 'void' | 'black' | 'surface';
  id?: string;
  size?: 'sm' | 'md' | 'lg';
}): React.ReactElement {
  const padding = {
    sm: 'py-14 lg:py-20',
    md: 'py-20 lg:py-32',
    lg: 'py-28 lg:py-44',
  }[size];

  const background = { void: 'bg-void', black: 'bg-black', surface: 'bg-surface' }[tone];

  return (
    <section id={id} className={cn('relative', background, padding, className)}>
      {width === 'full' ? (
        children
      ) : (
        <div
          className={cn(
            'mx-auto px-5 lg:px-8',
            width === 'content' ? 'max-w-content' : 'max-w-wide',
          )}
        >
          {children}
        </div>
      )}
    </section>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  lead,
  align = 'left',
  className,
  action,
}: {
  eyebrow?: string;
  title: React.ReactNode;
  lead?: React.ReactNode;
  align?: 'left' | 'center';
  className?: string;
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <Reveal
      className={cn(
        'flex flex-col gap-5',
        align === 'center' && 'items-center text-center',
        className,
      )}
    >
      {eyebrow === undefined ? null : <Eyebrow accent>{eyebrow}</Eyebrow>}

      <div
        className={cn(
          'flex flex-col gap-5',
          action === undefined ? '' : 'lg:flex-row lg:items-end lg:justify-between lg:gap-10',
        )}
      >
        <h2
          className={cn(
            'font-display text-headline font-black text-ink uppercase',
            align === 'center' ? 'max-w-3xl' : 'max-w-[18ch]',
          )}
        >
          {title}
        </h2>
        {action === undefined ? null : <div className="shrink-0">{action}</div>}
      </div>

      {lead === undefined ? null : (
        <p
          className={cn('text-lead max-w-2xl text-ink-secondary', align === 'center' && 'mx-auto')}
        >
          {lead}
        </p>
      )}
    </Reveal>
  );
}

/**
 * Header for a non-hero page.
 *
 * Sits under the fixed navigation, so it carries the top padding the shell
 * deliberately does not apply globally.
 */
export function PageHeader({
  eyebrow,
  title,
  lead,
  children,
  className,
}: {
  eyebrow?: string;
  title: React.ReactNode;
  lead?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <header
      className={cn(
        'relative overflow-hidden border-b border-line bg-black pt-(--header-height)',
        className,
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          backgroundImage:
            'radial-gradient(70% 90% at 12% 0%, #12200f 0%, transparent 62%), linear-gradient(180deg, #060806 0%, #050705 100%)',
        }}
      />
      <div className="x-grid-field absolute inset-0 opacity-40" aria-hidden />

      <div className="relative mx-auto max-w-content px-5 pt-16 pb-14 lg:px-8 lg:pt-24 lg:pb-20">
        {eyebrow === undefined ? null : (
          <Eyebrow accent className="mb-5">
            {eyebrow}
          </Eyebrow>
        )}
        <h1 className="font-display text-display max-w-[14ch] font-black text-ink uppercase">
          {title}
        </h1>
        {lead === undefined ? null : (
          <p className="text-lead mt-6 max-w-2xl text-ink-secondary">{lead}</p>
        )}
        {children}
      </div>
    </header>
  );
}
