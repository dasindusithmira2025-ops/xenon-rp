# XenonRP rulebook publishing

The public `/rules` page reads the currently published XenonRP ruleset from the database and makes no external requests while players view it.

The authored source is [`docs/rules/xenon-rulebook.md`](rules/xenon-rulebook.md). It preserves the rulebook’s eleven subject areas while replacing server-specific counts, locations, deadlines, mechanics, and punishment promises with XenonRP’s own published policies. The source Markdown is authoritative for the XenonRP ruleset.

To review and publish an update:

1. Edit the authored Markdown, keeping one H1 title and one H2 per rule section.
2. Run `pnpm rules:sync:plan`. It reads the local Markdown and prints a page-by-page diff without changing the database.
3. Review all additions, removals, wording changes, and the number of currently published rules that the apply step will retire.
4. Run `pnpm rules:sync:apply` to publish a new versioned ruleset. The transaction preserves prior revisions and acceptances, retires other published rules, and invalidates the public rulebook cache.
5. Run `pnpm rules:sync:verify` to compare the database rules, revisions, and current ruleset against the authored Markdown.

Applying creates a new current ruleset, so players may need to accept the new version during onboarding. Stored paths and hashes identify the authored XenonRP content. Verification checks the local authored source against the database.
