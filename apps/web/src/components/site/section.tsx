import { cn, Eyebrow } from '@xenon/ui';
import { AnimatedDivider, MaskReveal, Reveal } from '@xenon/ui/motion';

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

/**
 * The section entrance, defined once.
 *
 * Every public page is built from these, so the arrival order set here is the
 * site's rhythm rather than one section's idea:
 *
 *   label → headline (masked) → standfirst → action
 *
 * The steps are 90-120ms apart, which is enough for the eye to follow the
 * order and short enough that the whole block has landed inside half a second.
 * The headline is masked rather than faded because it is the one element in the
 * group that should feel *set* rather than shown, and the contrast between the
 * mask and the fades either side is what gives a section a focal point.
 */
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
    <div
      className={cn(
        'flex flex-col gap-5',
        align === 'center' && 'items-center text-center',
        className,
      )}
    >
      {eyebrow === undefined ? null : (
        <Reveal distance={10}>
          <Eyebrow accent>{eyebrow}</Eyebrow>
        </Reveal>
      )}

      <div
        className={cn(
          'flex flex-col gap-5',
          action === undefined ? '' : 'lg:flex-row lg:items-end lg:justify-between lg:gap-10',
        )}
      >
        <MaskReveal delay={0.09} amount={0.4}>
          <h2
            className={cn(
              'font-display text-headline font-black text-ink uppercase',
              align === 'center' ? 'max-w-3xl' : 'max-w-[18ch]',
            )}
          >
            {title}
          </h2>
        </MaskReveal>
        {action === undefined ? null : (
          <Reveal delay={0.3} distance={10} className="shrink-0">
            {action}
          </Reveal>
        )}
      </div>

      {lead === undefined ? null : (
        <Reveal delay={0.2} distance={14}>
          <p
            className={cn(
              'text-lead max-w-2xl text-ink-secondary',
              align === 'center' && 'mx-auto',
            )}
          >
            {lead}
          </p>
        </Reveal>
      )}
    </div>
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

      {/*
        The same choreography as a section heading, half a beat slower.

        A page header is the first thing on the route, arriving straight after a
        navigation, so it plays on mount rather than on scroll - `Reveal` and
        `MaskReveal` both trigger in the viewport, and this is always in it.
      */}
      <div className="relative mx-auto max-w-content px-5 pt-16 pb-14 lg:px-8 lg:pt-24 lg:pb-20">
        {eyebrow === undefined ? null : (
          <Reveal distance={10} className="mb-5">
            <Eyebrow accent>{eyebrow}</Eyebrow>
          </Reveal>
        )}
        <MaskReveal delay={0.1}>
          <h1 className="font-display text-display max-w-[14ch] font-black text-ink uppercase">
            {title}
          </h1>
        </MaskReveal>
        {lead === undefined ? null : (
          <Reveal delay={0.24} distance={14}>
            <p className="text-lead mt-6 max-w-2xl text-ink-secondary">{lead}</p>
          </Reveal>
        )}
        {children === undefined ? null : (
          <Reveal delay={0.34} distance={12}>
            {children}
          </Reveal>
        )}
      </div>

      {/* A hairline drawing itself along the bottom edge as the header settles.
          It is the only decoration on the block and it marks where the page
          proper begins. */}
      <AnimatedDivider tone="accent" className="absolute inset-x-0 bottom-0 opacity-50" />
    </header>
  );
}
