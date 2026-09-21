'use client';

import { Check, Copy, Search, X } from 'lucide-react';
import * as React from 'react';

import type { PublishedRulebook } from '@xenon/domain';
import { Badge, cn, EmptyState, Input } from '@xenon/ui';

/**
 * The rulebook browser.
 *
 * Search runs in the browser over the already-rendered ruleset rather than
 * round-tripping per keystroke: the whole published rulebook is a few dozen
 * short records, so a server call would add latency and a rate limit to
 * something that should feel instant.
 *
 * Shorthand matters more than titles here. The community searches "RDM", not
 * "Random deathmatch is prohibited", so an alias hit outranks a title hit and a
 * title hit outranks a body hit.
 */

export interface RulebookBrowserProps {
  readonly rulebook: PublishedRulebook;
}

const severityTone = {
  GUIDELINE: 'neutral',
  STANDARD: 'info',
  SERIOUS: 'warning',
  ZERO_TOLERANCE: 'danger',
} as const;

const severityLabel = {
  GUIDELINE: 'Guideline',
  STANDARD: 'Standard',
  SERIOUS: 'Serious',
  ZERO_TOLERANCE: 'Zero tolerance',
} as const;

export function RulebookBrowser({ rulebook }: RulebookBrowserProps): React.ReactElement {
  const [query, setQuery] = React.useState('');
  const [activeCategory, setActiveCategory] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState<string | null>(null);

  const needle = query.trim().toLowerCase();

  const categories = React.useMemo(() => {
    if (needle.length === 0) {
      return activeCategory === null
        ? rulebook.categories
        : rulebook.categories.filter((category) => category.slug === activeCategory);
    }

    // Scoring, highest first. An exact alias or code match jumps to the top;
    // everything else is ranked by where the match landed.
    return rulebook.categories
      .map((category) => ({
        ...category,
        rules: category.rules
          .map((rule) => {
            let score = 0;
            if (rule.aliases.some((alias) => alias.toLowerCase() === needle)) score += 100;
            if (rule.code.toLowerCase() === needle) score += 90;
            if (rule.aliases.some((alias) => alias.toLowerCase().includes(needle))) score += 40;
            if (rule.title.toLowerCase().includes(needle)) score += 30;
            if (rule.code.toLowerCase().includes(needle)) score += 20;
            if (rule.description.toLowerCase().includes(needle)) score += 10;
            return { rule, score };
          })
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((entry) => entry.rule),
      }))
      .filter((category) => category.rules.length > 0);
  }, [rulebook.categories, needle, activeCategory]);

  const matchCount = categories.reduce((total, category) => total + category.rules.length, 0);

  const copyLink = React.useCallback((slug: string) => {
    const url = `${window.location.origin}${window.location.pathname}#${slug}`;
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(slug);
      setTimeout(() => {
        setCopied(null);
      }, 1800);
    });
  }, []);

  return (
    <div className="grid gap-10 lg:grid-cols-[15rem_1fr] lg:gap-14">
      <nav aria-label="Rule categories" className="lg:sticky lg:top-28 lg:self-start">
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
            }}
            placeholder="RDM, NLR, metagaming…"
            aria-label="Search the rulebook"
            className="pl-9"
          />
          {query.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                setQuery('');
              }}
              aria-label="Clear search"
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded-sm p-1 text-ink-muted hover:text-ink"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>

        <p className="mt-3 font-mono text-[0.625rem] tracking-[0.14em] text-ink-muted uppercase">
          {needle.length > 0
            ? `${String(matchCount)} match${matchCount === 1 ? '' : 'es'}`
            : `${String(rulebook.ruleCount)} rules`}
        </p>

        <ul className="mt-6 flex gap-1.5 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible lg:pb-0">
          <li className="shrink-0">
            <button
              type="button"
              onClick={() => {
                setActiveCategory(null);
              }}
              className={cn(
                'w-full rounded-sm px-3 py-2 text-left text-sm whitespace-nowrap transition-colors',
                activeCategory === null
                  ? 'bg-elevated text-ink'
                  : 'text-ink-muted hover:text-ink-secondary',
              )}
            >
              All rules
            </button>
          </li>
          {rulebook.categories.map((category) => (
            <li key={category.slug} className="shrink-0">
              <button
                type="button"
                onClick={() => {
                  setActiveCategory(category.slug);
                  setQuery('');
                }}
                className={cn(
                  'w-full rounded-sm px-3 py-2 text-left text-sm whitespace-nowrap transition-colors',
                  activeCategory === category.slug
                    ? 'bg-elevated text-ink'
                    : 'text-ink-muted hover:text-ink-secondary',
                )}
              >
                {category.name}
                <span className="ml-2 font-mono text-[0.625rem] text-ink-muted">
                  {category.rules.length}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="flex flex-col gap-16">
        {categories.length === 0 ? (
          <EmptyState
            title="Nothing matches that"
            description="Try a shorthand like RDM or NLR, a rule code like GEN-4, or a word from the rule itself."
          />
        ) : (
          categories.map((category) => (
            <section key={category.slug} id={category.slug} className="scroll-mt-28">
              <h2 className="font-display text-title font-black text-ink uppercase">
                {category.name}
              </h2>
              {category.description === null ? null : (
                <p className="mt-2 text-ink-muted">{category.description}</p>
              )}

              <div className="mt-8 flex flex-col divide-y divide-line border-y border-line">
                {category.rules.map((rule) => (
                  <article key={rule.id} id={rule.slug} className="scroll-mt-28 py-7">
                    <div className="flex flex-wrap items-center gap-3">
                      <a
                        href={`#${rule.slug}`}
                        className="font-mono text-xs tracking-[0.14em] text-xenon"
                      >
                        {rule.code}
                      </a>
                      <Badge tone={severityTone[rule.severity]}>
                        {severityLabel[rule.severity]}
                      </Badge>
                      <button
                        type="button"
                        onClick={() => {
                          copyLink(rule.slug);
                        }}
                        className="ml-auto inline-flex items-center gap-1.5 rounded-sm px-2 py-1 font-mono text-[0.625rem] tracking-[0.14em] text-ink-muted uppercase transition-colors hover:bg-elevated hover:text-ink"
                        aria-label={`Copy a link to ${rule.code}`}
                      >
                        {copied === rule.slug ? (
                          <>
                            <Check className="size-3" /> Copied
                          </>
                        ) : (
                          <>
                            <Copy className="size-3" /> Link
                          </>
                        )}
                      </button>
                    </div>

                    <h3 className="font-display mt-3 text-xl font-bold text-ink">{rule.title}</h3>

                    <p className="mt-3 max-w-3xl leading-relaxed text-ink-secondary">
                      {rule.description}
                    </p>

                    {rule.examples === null ? null : (
                      <div className="mt-4 max-w-3xl rounded-md border-l-2 border-warning/50 bg-warning/5 px-4 py-3">
                        <p className="x-eyebrow text-warning">For example</p>
                        <p className="mt-1.5 text-sm leading-relaxed text-ink-secondary">
                          {rule.examples}
                        </p>
                      </div>
                    )}

                    {rule.aliases.length === 0 ? null : (
                      <p className="mt-4 flex flex-wrap items-center gap-2">
                        <span className="x-eyebrow">Also called</span>
                        {rule.aliases.map((alias) => (
                          <button
                            key={alias}
                            type="button"
                            onClick={() => {
                              setQuery(alias);
                            }}
                            className="rounded-sm border border-line-strong px-2 py-0.5 text-xs text-ink-muted transition-colors hover:border-xenon/40 hover:text-xenon"
                          >
                            {alias}
                          </button>
                        ))}
                      </p>
                    )}
                  </article>
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
