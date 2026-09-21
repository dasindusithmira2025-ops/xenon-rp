# Local development

## First run

```bash
corepack enable
pnpm install

cp .env.example .env
docker compose up -d

pnpm db:generate
pnpm db:migrate
pnpm db:seed

pnpm lint && pnpm typecheck && pnpm test
```

If all three verification commands pass, the workspace is set up correctly.

## Filling in `.env`

`.env` lives at the **repository root only**. There is no per-app `.env`: the
web tier, the bot and the Prisma CLI all read the same `DATABASE_URL`, and
keeping three copies in sync is a reliable way to produce "works on my machine".

Loading is done by `process.loadEnvFile` via `@xenon/config/load-env`, which
leaves already-defined variables alone. A real environment variable therefore
always beats the file — which is what makes CI and container deployments behave.

### Required before anything boots

| Variable                                 | Where to get it                                              |
| ---------------------------------------- | ------------------------------------------------------------ |
| `AUTH_SECRET`                            | `openssl rand -base64 32`                                    |
| `AUTH_DISCORD_ID`, `AUTH_DISCORD_SECRET` | Discord Developer Portal → your app → OAuth2                 |
| `DISCORD_BOT_TOKEN`                      | Discord Developer Portal → your app → Bot → Reset Token      |
| `DISCORD_APPLICATION_ID`                 | Discord Developer Portal → General Information               |
| `DISCORD_GUILD_ID`                       | Right-click your server → Copy Server ID (Developer Mode on) |

Add `http://localhost:3000/api/auth/callback/discord` as an OAuth2 redirect URI.

### Optional locally, required in production

`R2_*`, `TURNSTILE_SECRET`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and
`FIVEM_BRIDGE_SECRET` may be left blank for development — the app falls back to
documented development drivers. Setting `NODE_ENV=production` with any of them
missing makes the process refuse to start and name each one. That refusal is
deliberate: a production deploy quietly writing uploads to a container's
ephemeral disk is worse than a deploy that fails loudly.

### Discord role IDs are not in `.env`

They live in the `DiscordRoleMapping` table and are managed from
`/control → Integrations`. Changing which Discord role means "whitelisted" is an
operational decision, and should not require a redeploy.

## Infrastructure

`docker-compose.yml` runs Postgres 18 and Redis 8 on **non-default host ports**:

| Service  | Host port | Why not the default                                   |
| -------- | --------- | ----------------------------------------------------- |
| Postgres | **5442**  | 5432 is usually taken by another project on a dev box |
| Redis    | **6389**  | same reasoning for 6379                               |

```bash
pnpm infra:up       # start
pnpm infra:down     # stop, keep data
pnpm infra:reset    # stop and DELETE the volumes
```

`pnpm infra:reset` destroys your local database. After it, re-run
`pnpm db:migrate && pnpm db:seed`.

## Database work

```bash
pnpm db:migrate                # edit schema.prisma first, then this
pnpm db:generate               # regenerate the client after a schema change
pnpm db:studio                 # browse data
pnpm db:seed                   # idempotent; safe to re-run any time
```

Prisma 7 no longer reads `.env` on its own and no longer accepts `url` inside
`schema.prisma`. Both live in `packages/database/prisma.config.ts`.

The seed only writes the capability catalogue and default roles. It never
invents departments, rules, application questions, Discord IDs or statistics —
those are staff decisions made in `/control`, and a seeded guess would be
fiction somebody later has to find and delete.

## Becoming an admin

```bash
pnpm --filter @xenon/database grant-owner <your-discord-user-id>
```

Sign in with Discord once first, so the account exists. Sign out and back in
afterwards for the new capabilities to appear in your session.

## Troubleshooting

**`port is already allocated` on `docker compose up`**
Something else holds 5442 or 6389. Find it with `docker ps` or
`netstat -ano | findstr 5442`, then either stop it or change the host port in
`docker-compose.yml` and the matching URL in `.env`.

**Postgres container restarts in a loop**
Usually a volume created by a different Postgres major version. `pnpm infra:reset`,
then re-migrate. The Postgres 18 image expects its mount at `/var/lib/postgresql`,
not `/var/lib/postgresql/data`.

**`WARN Unsupported engine: wanted {"node":">=24.17.0"}`**
Your Node is older than the declared minimum. It is a warning, not an error —
`engine-strict` is off so development is not blocked — but install 24.21.0
(`nvm install 24.21.0`) to match CI.

**`EnvironmentValidationError` on startup**
Intentional. The message lists every missing or malformed variable at once.
Fix them all, then restart.

**ESLint: `'process.env' is restricted from being used`**
Also intentional. Read configuration from `@xenon/config` instead. If you are
genuinely writing a new configuration boundary, add a scoped override in that
package's `eslint.config.mjs` with a comment explaining why.

**Turborepo: `Cyclic dependency detected`**
Two packages depend on each other, counting `devDependencies`. Fix the layering
rather than the symptom — see the package graph in
[ARCHITECTURE.md](ARCHITECTURE.md).

## Conventions

- **Server components by default.** Reach for `'use client'` only when real
  browser interactivity requires it.
- **No `any`, no unsafe casts.** ESLint fails the build on them.
- **`switch` over a domain union ends in `assertNever()`,** so adding a status
  and forgetting a branch is a type error rather than a silent fallthrough.
- **Every mutation checks authorization server-side.** Hiding a link is not
  access control.
- **Tests earn their place.** One good test that would fail if the logic broke
  beats ten that assert the obvious.
