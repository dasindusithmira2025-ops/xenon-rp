import Link from 'next/link';

import { ScrollProgress } from '@xenon/ui/motion';

import { PageHeader, Section } from '~/components/site/section';

/**
 * Shell for the legal pages.
 *
 * Numbered sections with their own anchors, because the only reason anybody
 * links to a page like this is to point at one specific paragraph.
 *
 * The sidebar is a plain list of links rather than a scroll-spy: these pages
 * are short, and a highlight that lags the scroll is worse than none.
 */

export interface LegalSection {
  readonly heading: string;
  readonly body: readonly string[];
}

function anchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function LegalDocument({
  eyebrow,
  title,
  updated,
  sections,
}: {
  eyebrow: string;
  title: string;
  updated: string;
  sections: readonly LegalSection[];
}): React.ReactElement {
  return (
    <>
      <ScrollProgress />

      <PageHeader eyebrow={eyebrow} title={title} lead={updated} />

      <Section width="content">
        <div className="grid gap-12 lg:grid-cols-[1fr_16rem] lg:gap-16">
          <div className="order-2 flex flex-col gap-12 lg:order-1">
            {sections.map((section, index) => (
              <section key={section.heading} id={anchor(section.heading)} className="scroll-mt-28">
                <h2 className="font-display flex items-baseline gap-4 text-xl font-bold text-ink">
                  <span className="font-mono text-[0.6875rem] tracking-[0.2em] text-ink-muted">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  {section.heading}
                </h2>
                <div className="mt-4 flex flex-col gap-4 pl-0 lg:pl-11">
                  {section.body.map((paragraph) => (
                    <p
                      key={paragraph.slice(0, 40)}
                      className={
                        // Operator to-dos are marked so nobody ships them by
                        // accident, and so a reviewer can find them in seconds.
                        paragraph.startsWith('OPERATOR ACTION REQUIRED')
                          ? 'rounded-md border border-warning/30 bg-warning/5 px-4 py-3 text-sm leading-relaxed text-warning'
                          : 'leading-relaxed text-ink-secondary'
                      }
                    >
                      {paragraph}
                    </p>
                  ))}
                </div>
              </section>
            ))}
          </div>

          <nav
            aria-label="On this page"
            className="order-1 lg:order-2 lg:sticky lg:top-28 lg:self-start"
          >
            <p className="x-eyebrow">On this page</p>
            <ul className="mt-4 flex flex-col gap-2.5 border-l border-line pl-4">
              {sections.map((section) => (
                <li key={section.heading}>
                  <Link
                    href={`#${anchor(section.heading)}`}
                    className="text-sm text-ink-muted transition-colors hover:text-xenon"
                  >
                    {section.heading}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </Section>
    </>
  );
}
