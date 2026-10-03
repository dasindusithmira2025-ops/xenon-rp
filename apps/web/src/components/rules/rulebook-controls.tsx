'use client';

import { Search, X } from 'lucide-react';
import * as React from 'react';

import { Badge, cn, EmptyState, Input } from '@xenon/ui';
import { instant, motion, useReducedMotion } from '@xenon/ui/motion';

interface RuleCategoryNavigation {
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly ruleCount: number;
}

interface RuleSectionNavigation {
  readonly slug: string;
  readonly title: string;
  readonly categorySlug: string;
  readonly searchText: string;
}

export function normalizeRulebookQuery(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase();
}

export function RulebookControls({
  categories,
  sections,
  children,
}: {
  readonly categories: readonly RuleCategoryNavigation[];
  readonly sections: readonly RuleSectionNavigation[];
  readonly children: React.ReactNode;
}): React.ReactElement {
  const reduced = useReducedMotion();
  const [query, setQuery] = React.useState('');
  const [activeCategory, setActiveCategory] = React.useState<string | null>(null);
  const [activeSection, setActiveSection] = React.useState<string | null>(null);
  const needle = normalizeRulebookQuery(query.trim());
  const visibleSections = React.useMemo(
    () =>
      new Set(
        sections
          .filter((section) => {
            const matchesQuery =
              needle.length === 0 || normalizeRulebookQuery(section.searchText).includes(needle);
            const matchesCategory =
              activeCategory === null || section.categorySlug === activeCategory;
            return matchesQuery && matchesCategory;
          })
          .map((section) => section.slug),
      ),
    [sections, needle, activeCategory],
  );
  const matchCount = visibleSections.size;
  const visibleActiveSection =
    activeSection !== null && visibleSections.has(activeSection) ? activeSection : null;

  React.useEffect(() => {
    const entries = Array.from(document.querySelectorAll<HTMLElement>('[data-rule-entry]'));

    for (const entry of entries) {
      const shown = visibleSections.has(entry.id);
      entry.hidden = !shown;
    }

    for (const group of document.querySelectorAll<HTMLElement>('[data-rule-category-section]')) {
      group.hidden = !entries.some(
        (entry) =>
          entry.dataset.ruleCategory === group.dataset.ruleCategorySection &&
          visibleSections.has(entry.id),
      );
    }
  }, [visibleSections]);

  React.useEffect(() => {
    const entries = Array.from(document.querySelectorAll<HTMLElement>('[data-rule-entry]'));
    if (entries.length === 0 || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (observed) => {
        const first = observed
          .filter((item) => item.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (first !== undefined && first.target instanceof HTMLElement) {
          setActiveSection(first.target.id);
        }
      },
      { rootMargin: '-18% 0px -72% 0px', threshold: 0 },
    );
    entries.forEach((entry) => {
      observer.observe(entry);
    });
    return () => {
      observer.disconnect();
    };
  }, [sections]);

  useDeepLinkHighlight();

  const categoryNav = (
    <ul className="mt-3 flex gap-1.5 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible lg:pb-0">
      <li className="shrink-0">
        <button
          type="button"
          onClick={() => {
            setActiveCategory(null);
            setActiveSection(null);
          }}
          aria-pressed={activeCategory === null}
          className={cn(
            'w-full rounded-sm px-3 py-2 text-left text-sm whitespace-nowrap transition-colors',
            activeCategory === null ? 'bg-elevated text-ink' : 'text-ink-muted hover:text-ink',
          )}
        >
          All sections
        </button>
      </li>
      {categories.map((category) => (
        <li key={category.slug} className="shrink-0">
          <button
            type="button"
            onClick={() => {
              setActiveCategory((current) => (current === category.slug ? null : category.slug));
              setActiveSection(null);
            }}
            aria-pressed={activeCategory === category.slug}
            className={cn(
              'w-full rounded-sm px-3 py-2 text-left text-sm whitespace-nowrap transition-colors',
              activeCategory === category.slug
                ? 'bg-elevated text-ink'
                : 'text-ink-muted hover:text-ink',
            )}
          >
            {category.name}
            <span className="ml-2 font-mono text-[0.625rem] text-ink-muted">
              {String(category.ruleCount)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );

  const sectionLinks = (mobile: boolean): React.ReactElement => (
    <ul
      className={cn(
        'flex flex-col gap-1',
        mobile ? 'max-h-72 overflow-y-auto' : 'max-h-[52vh] overflow-y-auto',
      )}
    >
      {sections.map((section) => {
        const visible = visibleSections.has(section.slug);
        return (
          <li key={section.slug} hidden={!visible}>
            <a
              href={`#${section.slug}`}
              data-rule-nav={section.slug}
              aria-current={visibleActiveSection === section.slug ? 'location' : undefined}
              onClick={(event) => {
                if (mobile) event.currentTarget.closest('details')?.removeAttribute('open');
              }}
              className={cn(
                'block rounded-sm px-3 py-2 text-xs leading-5 break-words transition-colors',
                visibleActiveSection === section.slug
                  ? 'bg-elevated text-xenon'
                  : 'text-ink-muted hover:text-ink-secondary',
              )}
            >
              {section.title}
            </a>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="grid min-w-0 gap-8 lg:grid-cols-[16rem_minmax(0,1fr)] lg:gap-14">
      <aside className="min-w-0 lg:sticky lg:top-28 lg:self-start">
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveSection(null);
            }}
            placeholder="Search the rulebook…"
            aria-label="Search the rulebook"
            className="pl-9"
          />
          {query.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setActiveSection(null);
              }}
              aria-label="Clear search"
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded-sm p-1 text-ink-muted hover:text-ink"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>

        <p
          className="mt-3 font-mono text-[0.625rem] tracking-[0.14em] text-ink-muted uppercase"
          aria-live="polite"
        >
          {needle.length > 0
            ? `${String(matchCount)} matching section${matchCount === 1 ? '' : 's'}`
            : `${String(sections.length)} sections`}
        </p>

        <div className="mt-5 lg:hidden">
          <details className="group rounded-md border border-line bg-surface/70">
            <summary className="cursor-pointer list-none px-3 py-3 text-sm text-ink-secondary">
              Browse sections
              <Badge tone="neutral" className="ml-2">
                {String(matchCount)}
              </Badge>
            </summary>
            <div className="border-t border-line px-1 py-2">{sectionLinks(true)}</div>
          </details>
        </div>

        <div className="mt-5 hidden lg:block">
          <p className="x-eyebrow">Rulebook</p>
          {categoryNav}
          <p className="x-eyebrow mt-8 mb-2">Sections</p>
          {sectionLinks(false)}
        </div>
      </aside>

      <main className="min-w-0">
        {matchCount === 0 && needle.length > 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={instant(reduced, { duration: 0.25, ease: [0.16, 1, 0.3, 1] })}
          >
            <EmptyState
              title="Nothing matches that"
              description="Search with the original spelling in the rulebook."
            />
          </motion.div>
        ) : (
          children
        )}
      </main>
    </div>
  );
}

function useDeepLinkHighlight(): void {
  React.useEffect(() => {
    const highlight = (): void => {
      const slug = window.location.hash.slice(1);
      if (slug === '') return;
      const target = document.getElementById(slug);
      if (target === null) return;
      target.classList.remove('x-deeplink-pulse');
      void target.getBoundingClientRect();
      target.classList.add('x-deeplink-pulse');
    };

    highlight();
    window.addEventListener('hashchange', highlight);
    return () => {
      window.removeEventListener('hashchange', highlight);
    };
  }, []);
}
