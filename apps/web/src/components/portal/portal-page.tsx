import { cn } from '@xenon/ui';

/**
 * Page scaffolding inside the portal.
 *
 * The portal is an application rather than a document, so the rhythm is
 * tighter than the public site: a compact header, a consistent gutter, and a
 * single max width so a table and a form line up down the page.
 */
export function PortalPage({
  title,
  lead,
  actions,
  children,
  className,
}: {
  title: string;
  lead?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div
      className={cn('mx-auto flex max-w-5xl flex-col gap-8 px-5 py-8 lg:px-10 lg:py-12', className)}
    >
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-2">
          <h1 className="font-display text-title font-black text-ink uppercase">{title}</h1>
          {lead === undefined ? null : (
            <p className="max-w-2xl text-sm leading-relaxed text-ink-secondary">{lead}</p>
          )}
        </div>
        {actions === undefined ? null : <div className="flex shrink-0 gap-2">{actions}</div>}
      </header>

      {children}
    </div>
  );
}

/** A labelled block inside a portal page. */
export function PortalSection({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <section className={cn('flex flex-col gap-4', className)}>
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="x-eyebrow">{title}</h2>
          {description === undefined ? null : (
            <p className="mt-1.5 text-sm text-ink-muted">{description}</p>
          )}
        </div>
        {actions === undefined ? null : <div className="shrink-0">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
