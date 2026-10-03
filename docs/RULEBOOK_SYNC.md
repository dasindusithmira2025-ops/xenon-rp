# Official rulebook sync

The public `/rules` page reads the currently published Xenon rule set from the database. It does not request GitBook while a player is viewing the page.

The source of truth is [CityLifeRpGangRule on GitBook](https://mycompany-181.gitbook.io/cityliferpgangrule-docs). The sync tool reads its `llms.txt`, page sitemap, and each page's Markdown endpoint. The landing page provides the rulebook title; the remaining pages are imported in source order as page-level rules. Exact source Markdown and its SHA-256 hash are saved in `docs/rules/official-snapshot.json` and in Xenon's rule, revision, and rule-set records.

To update the rules after GitBook changes:

1. Run `pnpm rules:sync:plan`. This fetches and saves a candidate snapshot, verifies the index against the sitemap, and prints a page-by-page diff without changing the database.
2. Review the reported additions, removals, wording changes, and order changes.
3. Run `pnpm rules:sync:apply` to publish the candidate as a new ruleset. The transaction retires other published rules and preserves prior revisions and acceptances.
4. Run `pnpm rules:sync:verify` to fetch GitBook again and compare its current content, page order, hashes, database rules, revisions, and published ruleset against the candidate.

The public rulebook cache is invalidated after import. The import stores source URLs, page paths, source order, retrieval time, and content hashes with the corresponding records.
