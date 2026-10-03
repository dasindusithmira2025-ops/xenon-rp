import type { PublishedRulebook } from '@xenon/domain';

import { CopyRuleLink } from '~/components/rules/copy-rule-link';
import { RuleMarkdownContent } from '~/components/rules/rule-markdown-content';
import { RulebookControls } from '~/components/rules/rulebook-controls';

export function RulebookBrowser({ rulebook }: { readonly rulebook: PublishedRulebook }) {
  const categories = rulebook.categories.map((category) => ({
    slug: category.slug,
    name: category.name,
    description: category.description,
    ruleCount: category.rules.length,
  }));
  const sections = rulebook.categories.flatMap((category) =>
    category.rules.map((rule) => ({
      slug: rule.slug,
      title: rule.title,
      categorySlug: category.slug,
      searchText: `${rule.title}\n${rule.description}`,
    })),
  );

  return (
    <RulebookControls categories={categories} sections={sections}>
      {rulebook.categories.map((category) => (
        <section
          key={category.slug}
          id={`category-${category.slug}`}
          data-rule-category-section={category.slug}
          className="scroll-mt-28"
        >
          <h2 className="font-display text-title font-black text-ink">{category.name}</h2>
          {category.description === null ? null : (
            <p className="mt-2 text-ink-muted">{category.description}</p>
          )}

          <div className="mt-8 flex flex-col divide-y divide-line border-y border-line">
            {category.rules.map((rule) => (
              <article
                key={rule.id}
                id={rule.slug}
                data-rule-entry
                data-rule-category={category.slug}
                className="x-rule-entry scroll-mt-28 border-b border-line py-7 last:border-b-0"
              >
                <div data-rule-search-content>
                  <h3 className="font-display break-words text-xl font-bold text-ink">
                    {rule.title}
                  </h3>
                  <RuleMarkdownContent markdown={rule.description} />
                </div>
                <div className="mt-4 flex items-center justify-end">
                  <CopyRuleLink slug={rule.slug} />
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}
    </RulebookControls>
  );
}
