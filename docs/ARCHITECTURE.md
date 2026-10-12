# Architecture

## The one rule

XenonRP is **one platform with several interfaces**, not several applications
that happen to share a database.

```
        ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
        │  Public web  │   │ Player portal│   │  /control    │   apps/web
        └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
               │                  │                  │
        ┌──────┴──────────────────┴──────────────────┴───────┐
        │        Shared domain services (packages/*)         │
        │  approveApplication  grantWhitelist  linkIdentity  │
        └──┬──────────────┬──────────────┬──────────────┬────┘
           │              │              │              │
   ┌───────┴──────┐ ┌─────┴──────┐ ┌─────┴──────┐ ┌─────┴──────┐
   │  PostgreSQL  │ │   Redis    │ │ core-api   │ │  worker    │
   │ source of    │ │ jobs, rate │ │ /internal  │ │ queue,     │
   │ truth+outbox │ │ limits     │ │ for Link   │ │ outbox     │
   └──────────────┘ └────────────┘ └─────┬──────┘ └─────┬──────┘
                                         │ signed       │ signed
                                   ┌─────┴──────────────┴─────┐
                                   │  apps/link-bot (Link)    │  Discord app #2
                                   └──────────────────────────┘

   apps/guardian-bot (Guardian) — Discord app #1, no edge to any box above.
```

The two Discord applications, their commands, permissions and deployment are
described in [TWO_BOT_MIGRATION.md](TWO_BOT_MIGRATION.md).

A business operation is written **once**, in a domain package, and called from
every interface. `approveApplication()` is the same function whether it was
triggered by a staff member clicking Approve in `/control` or pressing a button
on a Discord embed. The only thing that differs is the `Actor` passed in and the
`source` recorded on the audit entry.

The failure this prevents is the common one: a Discord bot that reimplements
approval slightly differently from the website, and the two drift until nobody
can say which is correct.

## What is authoritative

| Fact                          | Authority                         | Everything else is… |
| ----------------------------- | --------------------------------- | ------------------- |
| Who a player is               | `User` + `DiscordAccount`         | a cached projection |
| What a player may do          | `UserRole` → `RolePermission`     | —                   |
| Whether they are whitelisted  | `Whitelist`                       | a sync target       |
| Which Discord roles they hold | `UserRole` + `DiscordRoleMapping` | a sync target       |
| Application state             | `ApplicationSubmission.status`    | —                   |

Discord roles are **not** an input to authorization. A staff member who grants
themselves a Discord role gains nothing, because `resolveActor()` reads
capabilities from the database. `DiscordAccount.guildRoleIds` is stored for
diagnostics only, and the code that reads it does not decide anything.

## Package graph

Edges run one way. `pnpm typecheck` fails if a cycle is introduced, because
Turborepo refuses to build a cyclic task graph.

```
        config      (no internal dependencies)
          │
        logger
          │
         core       (no internal dependencies: errors, public ids,
          │          capability catalogue, role presets, domain unions)
          │
       database     → core, config         contracts (zod only: events,
          │                                 service auth, Core/Link APIs)
          │
      permissions   → core;  database is type-only (devDependency)
          │
   jobs (→ database, contracts) / applications / auth / discord / notifications / validation / ui
          │
      apps/web, apps/core-api, apps/worker, fivem/xenon_bridge

      apps/link-bot     → contracts, discord (pure builders) — no database
      apps/guardian-bot → contracts, discord (pure provisioning) — no database
```

Two decisions worth knowing about:

**`core` holds the capability catalogue, `permissions` holds enforcement.**
The catalogue and role presets are pure data with no database edge, so they sit
in `core` where the seed script can read them without `database` having to
depend on `permissions` — which would close a cycle. `permissions` owns `Actor`,
`can()`, `requirePermission()` and `resolveActor()`, which is the part that
genuinely needs a database handle.

**`core` declares its own domain unions rather than importing Prisma enums.**
`ActionSource` is written out by hand in `core/src/domain.ts`. That is what keeps
`core` free of any database dependency. The cost is two places to keep in step,
so `packages/database/src/enum-parity.ts` asserts at compile time that each
union still matches its Prisma enum. Add a value to one and not the other and
`pnpm typecheck` fails.

## Transactions and side effects

The ordering rule, stated once:

> Commit the domain decision first. Enqueue external side effects second. Never
> let an external system roll back a decision that already happened.

Approving an application:

1. **One transaction**: update `ApplicationSubmission.status`, write an
   `ApplicationEvent`, write an `AuditLog`, update `Whitelist`, insert
   `UserRole` rows, and write the outbox rows (role sync, review-card update,
   whitelist push, `WHITELIST_APPROVED`). Either all of it or none of it.
2. **After it commits**: the worker's relay moves the outbox rows onto the
   queue — grant the Discord role (through Link), edit the review message, DM
   the applicant, push whitelist state to FXServer.
   The worker reaches Link over one of two transports: signed HTTP to Link's
   gateway (`LINK_GATEWAY_MODE=http`, default) or the relay (`relay`), where the
   worker parks the signed request in Redis, Link pulls it from Core over
   outbound HTTPS, verifies the worker's signature itself, executes it and
   posts the result back. See [SECURITY.md](SECURITY.md) for the trust
   boundaries.
3. **Workers retry.** Every job is idempotent, so a retry re-applies the same
   end state rather than granting a role twice.

If Discord is down, the application is still approved, the portal already shows
it, and the role arrives when Discord returns. An applicant is never left stuck
because an integration had a bad afternoon.

## Errors

Domain services throw typed errors from `@xenon/core`. Each transport translates
them once:

| Error                  | HTTP | Transport behaviour                      |
| ---------------------- | ---- | ---------------------------------------- |
| `UnauthenticatedError` | 401  | Prompt sign-in                           |
| `ForbiddenError`       | 403  | Access denied                            |
| `NotFoundError`        | 404  | Not-found page                           |
| `ConflictError`        | 409  | Explain why the action is unavailable    |
| `ValidationError`      | 422  | Render per-field messages on the form    |
| `RateLimitError`       | 429  | Retry-After                              |
| `IntegrationError`     | 502  | Degrade the panel, keep the rest working |

Every error carries a `safeMessage`. That is the only text a transport may show
a user — an unexpected exception message can contain a connection string, so
unknown errors collapse to a generic line instead.

## Configuration

`@xenon/config` is the only module permitted to read `process.env`; ESLint
enforces it everywhere else. Each runtime gets its own schema, holding only the
credentials that process needs:

- `@xenon/config/server` — the web tier. No bot token.
- `@xenon/config/guardian` — Guardian: its own Discord token, nothing else.
- `@xenon/config/link` — Link: its own Discord token plus the Core API and
  gateway service secrets, and `LINK_GATEWAY_MODE` (`http`: listen for the
  worker; `relay`: pull worker requests through Core, no socket). No database
  or Redis.
- `@xenon/config/core-api`, `@xenon/config/worker` — datastores and service
  secrets, no Discord token. The worker takes `LINK_GATEWAY_MODE` too and needs
  `LINK_GATEWAY_URL` only in `http` mode.
- `@xenon/config/datastore`, `@xenon/config/fivem` — narrow slices shared by
  low-level packages.
- `@xenon/config/public` — the handful of `NEXT_PUBLIC_*` values.

Validation is lazy — Next.js evaluates modules during build in contexts where
runtime secrets are legitimately absent — but total: the first real access
reports every problem at once.

## Side effects: the outbox

Domain services write side effects to `outbox_messages` with
`enqueueDurable(…, { db: tx })` and integration events with
`emitIntegrationEvent(tx, …)`, inside the transaction that made the decision.
The worker's relay moves due rows onto BullMQ (jobs) or fans them out to
subscribers (events, typed and versioned in `@xenon/contracts`). A Redis or
Discord outage delays a side effect; it can no longer lose one, and a retried
delivery is de-duplicated by `integration_event_receipts`.
