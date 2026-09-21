# Database

PostgreSQL 18, accessed through Prisma 7 with the `@prisma/adapter-pg` driver
adapter. Schema: `packages/database/prisma/schema.prisma`.

## Migration rules

1. **Every schema change gets a migration.** `pnpm db:migrate` generates it.
2. **`db push` is never a production strategy.** CI runs `prisma migrate deploy`,
   which applies committed migrations and refuses to invent one.
3. **Do not rewrite a migration that has been committed.** Add a new one.
4. **Destructive changes are never automatic.** CI's `migrate diff --exit-code`
   step fails when `schema.prisma` has drifted ahead of the migrations folder,
   which is the mistake that would otherwise reach production as a silent
   column drop.
5. **Seeds are separate from migrations** and never carry community data.

## Public identifiers

Every entity a human refers to has an identifier separate from its primary key.

| Entity      | Shape           | Example      |
| ----------- | --------------- | ------------ |
| User        | `XN-#####`      | `XN-10082`   |
| Application | `XN-<SEG>-####` | `XN-WL-1842` |
| Character   | `XN-CH-####`    | `XN-CH-5819` |
| Ticket      | `XN-TK-####`    | `XN-TK-0452` |
| Interview   | `XN-IV-####`    | `XN-IV-0107` |
| Report      | `XN-RP-####`    | `XN-RP-0231` |
| Appeal      | `XN-AP-####`    | `XN-AP-0044` |

Two reasons for this. Staff quote these aloud in Discord and in voice, so they
must be short and speakable. And a URL must never expose a primary key, because
enumerating rows or counting them should not be possible from outside.

The application segment is **per template** (`ApplicationTemplate.publicIdPrefix`),
so a police intake produces `XN-PD-1843` while whitelist produces `XN-WL-1842`.
It is not unique across templates, and does not need to be: the number comes
from one shared sequence, so the full identifier still resolves to exactly one
row.

Numbers come from dedicated Postgres sequences (`public_id_*_seq`), not from
`count() + 1`, which races under concurrency, and not from the row id, which
would defeat the point. `nextval` is never rolled back, so a failed transaction
burns a number. Gaps are expected and harmless — uniqueness is the property that
matters, contiguity is not.

Users start at 10000 so the first account reads `XN-10082` rather than
`XN-00001`, which would advertise exactly how small the community is.

## Schema tour

### Identity

`User` is the account. `DiscordAccount` is a **projection** of Discord, held
separately because it is re-synced, goes stale, and must never be treated as the
identity. A Discord username change does not change who someone is.

`Account` (Auth.js OAuth tokens) is separate again from `DiscordAccount`: one
holds short-lived provider credentials, the other holds durable profile data.

`GameIdentity` is a row per proven FiveM identifier, because one player
legitimately has several (`steam:`, `license:`, `discord:`). Columns would have
forced a guess about how many.

`LinkToken` stores only a **SHA-256 of the code**. The plaintext `XEN-7K4P9` is
shown once and never persisted, so a database leak cannot be replayed into
account takeover during the ten-minute validity window.

### Authorization

`Role` → `RolePermission` → `Permission`, with `UserRole` joining users to roles.
`UserRole.expiresAt` supports trials and temporary elevation without a cron job:
`resolveActor()` simply ignores expired rows.

Discord role snowflakes appear in exactly one table: `DiscordRoleMapping`.
Nothing else in the codebase knows a role ID exists.

### Applications

Fully data-driven: `ApplicationTemplate` → `ApplicationSection` →
`ApplicationQuestion` → `ApplicationQuestionOption`. Staff add a department
intake by creating rows, not by shipping code.

`ApplicationAnswer` uses **typed columns** — `textValue`, `numberValue`,
`booleanValue`, `dateValue`, `choiceValues`, `mediaIds` — rather than one JSON
blob, so answers stay queryable and validation has something to bite on.
`ApplicationQuestion.key` is stable and separate from sort order, so reordering
a form never orphans an answer.

`ApplicationEvent` is the append-only timeline; every state transition writes
one. `ApplicationSubmission.revision` is a counter bumped on each autosave, and
is how a conflicting edit from a second tab is detected.

### Rules

`Rule` carries the current text; `RuleRevision` is an immutable snapshot of each
wording. `RuleSet` is a frozen published collection, and `RuleAcceptance` points
at a `RuleSet` rather than at "the rules as they are now". That is what makes
"which rules did this player actually agree to" a question with an exact answer
six months later.

### Integration bookkeeping

`DiscordMessageReference` stores the channel and message ID of every message the
bot owns, so a state change **edits** the existing review card instead of posting
a second one. `ServerStatusSnapshot` is written by the poller and read by
everything else, so no browser ever touches FXServer directly.

`ServiceHeartbeat` is how the health page knows the bot is alive without trying
to reach it synchronously.

### Audit

`AuditLog` is append-only by convention and by the absence of any update path in
the service layer. `actorLabel` is stored alongside `actorId` so the log stays
readable after an account is deleted and the foreign key goes null. `before` and
`after` hold safe projections — never secrets, never tokens.

## Conventions

- **cuid v2** primary keys — unguessable, and no coordination needed.
- **snake_case table names** via `@@map`; camelCase in TypeScript.
- **Soft delete only where history matters** (`User.deletedAt`,
  `ApplicationComment.deletedAt`). Everything else cascades honestly.
- **IPs are stored hashed** (`ipHash`), never raw. The audit log is not an
  address book.
- **Indexes follow real queries** — the staff queue, the player's own list, the
  audit trail for one entity — not every column on principle.
