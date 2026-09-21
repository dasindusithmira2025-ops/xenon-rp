# XenonRP

The platform for **XENON ROLEPLAY**, a Sri Lankan FiveM roleplay community.

One system, several interfaces: a public website, a player portal, a staff
control centre, a Discord bot and a FiveM bridge. They share one domain model
and one database. PostgreSQL is the source of truth — Discord roles and FiveM
whitelist state are projections of it, never inputs to it.

---

## Status

Built in phases. This table is the honest state of the repository, not a plan.

| Phase                    | State          |
| ------------------------ | -------------- |
| 0 — Foundation           | ✅ Done        |
| 1 — Public experience    | ⬜ Not started |
| 2 — Identity & RBAC      | ⬜ Not started |
| 3 — Application platform | ⬜ Not started |
| 4 — Discord bot          | ⬜ Not started |
| 5 — FiveM integration    | ⬜ Not started |
| 6 — Operations           | ⬜ Not started |
| 7 — Production hardening | ⬜ Not started |

Phase 0 delivers the workspace, validated configuration, the canonical database
schema with migrations, the capability catalogue with a seeded RBAC structure,
structured logging and CI.

---

## Requirements

| Tool    | Version    | Notes                                         |
| ------- | ---------- | --------------------------------------------- |
| Node.js | ≥ 24.17.0  | `.nvmrc` pins 24.21.0. `nvm use` picks it up. |
| pnpm    | ≥ 10.20.0  | `corepack enable` is enough.                  |
| Docker  | any recent | Runs Postgres and Redis locally.              |

Nothing else needs installing — no local Postgres, no local Redis.

---

## Quick start

```bash
git clone <repo> && cd "XENON RP"
corepack enable
pnpm install

cp .env.example .env                       # then fill in the REQUIRED values
docker compose up -d                       # Postgres :5442, Redis :6389

pnpm db:generate                           # generate the Prisma client
pnpm db:migrate                            # apply migrations
pnpm db:seed                               # capabilities + default roles
```

Verify the workspace is healthy:

```bash
pnpm lint && pnpm typecheck && pnpm test
```

The minimum you must fill into `.env` before anything will boot:

- `AUTH_SECRET` — `openssl rand -base64 32`
- `AUTH_DISCORD_ID` / `AUTH_DISCORD_SECRET` — from the Discord Developer Portal
- `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID`

`DATABASE_URL` and `REDIS_URL` already match `docker-compose.yml`.

Everything else is optional in development and **required in production** — the
config layer refuses to start a production process with object storage,
Turnstile or the FiveM bridge left unconfigured, rather than running degraded
without saying so.

> **Ports.** Postgres is on **5442** and Redis on **6389**, not the defaults.
> Dev machines commonly already have something on 5432/6379, and a project
> should not fight for them.

---

## Layout

```
apps/
  web/                 Next.js 16 — public site, player portal, /control
  bot/                 Persistent discord.js gateway service

packages/
  config/              Validated environment + brand constants + shared presets
  core/                Errors, public identifiers, capability catalogue, roles
  database/            Prisma schema, migrations, client, seed
  permissions/         Actor, capability checks, actor resolution
  auth/                Auth.js configuration and session helpers
  applications/        The application engine and its state machine
  discord/             Discord API adapters and embed builders
  notifications/       One notification abstraction across web / DM / channel
  validation/          Shared Zod schemas
  ui/                  Design system and shared components
  logger/              Structured logging with central redaction

fivem/
  xenon_bridge/        FiveM resource (JS built from TypeScript)

docs/                  Architecture, operations and setup guides
```

Package edges run one way: `core` depends on nothing internal, `database`
depends on `core`, and everything else depends on those. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Common commands

| Command                   | What it does                                   |
| ------------------------- | ---------------------------------------------- |
| `pnpm dev`                | Run every app in watch mode                    |
| `pnpm lint`               | ESLint across the workspace                    |
| `pnpm typecheck`          | `tsc --noEmit` per package                     |
| `pnpm test`               | Unit and integration tests                     |
| `pnpm build`              | Production build of every app                  |
| `pnpm format`             | Prettier write                                 |
| `pnpm db:migrate`         | Create and apply a migration                   |
| `pnpm db:deploy`          | Apply committed migrations (CI and production) |
| `pnpm db:studio`          | Prisma Studio                                  |
| `pnpm db:seed`            | Idempotent baseline seed                       |
| `pnpm infra:up` / `:down` | Start / stop Postgres and Redis                |
| `pnpm infra:reset`        | Stop and **delete** local database volumes     |

### Becoming an admin

Granting roles requires the `staff.manage` capability, which nobody has on a
fresh install. Sign in once with Discord, then break the deadlock from a shell:

```bash
pnpm --filter @xenon/database grant-owner <your-discord-user-id>
```

The escalation path deliberately requires database access, not merely a session.

---

## Documentation

| Document                                          | Covers                                    |
| ------------------------------------------------- | ----------------------------------------- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md)           | Package boundaries and why they are drawn |
| [LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md) | Running the stack, troubleshooting        |
| [DATABASE.md](docs/DATABASE.md)                   | Schema tour and migration rules           |
| [PERMISSIONS.md](docs/PERMISSIONS.md)             | The capability model                      |

`DISCORD_SETUP.md`, `FIVEM_SETUP.md`, `SECURITY.md`, `OPERATIONS.md` and
`DEPLOYMENT.md` land with the phases that make them true.
