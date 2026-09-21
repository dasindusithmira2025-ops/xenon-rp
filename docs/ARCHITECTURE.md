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
        └──────┬──────────────────┬──────────────────┬───────┘
               │                  │                  │
        ┌──────┴───────┐   ┌──────┴───────┐   ┌──────┴───────┐
        │  PostgreSQL  │   │    Redis     │   │  apps/bot    │
        │ source of    │   │ jobs + rate  │   │  Discord     │
        │ truth        │   │ limits       │   │  gateway     │
        └──────────────┘   └──────────────┘   └──────────────┘
```

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
       database     → core, config
          │
      permissions   → core;  database is type-only (devDependency)
          │
   applications / auth / discord / notifications / validation / ui
          │
      apps/web, apps/bot, fivem/xenon_bridge
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
   `UserRole` rows. Either all of it or none of it.
2. **After it commits**: enqueue Redis jobs — grant the Discord role, edit the
   review message, DM the applicant, push whitelist state to FXServer.
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
enforces it everywhere else. Each runtime gets its own schema:

- `@xenon/config/server` — the web tier. **Excludes `DISCORD_BOT_TOKEN`.**
- `@xenon/config/bot` — the gateway service. Holds the bot token, no OAuth secret.
- `@xenon/config/public` — the handful of `NEXT_PUBLIC_*` values.

The web tier never holds the bot token because it never talks to the gateway; it
enqueues jobs the bot performs. That keeps the most dangerous credential in the
one process that needs it.

Validation is lazy — Next.js evaluates modules during build in contexts where
runtime secrets are legitimately absent — but total: the first real access
reports every problem at once.
