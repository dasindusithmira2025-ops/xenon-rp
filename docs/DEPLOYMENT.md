# Deployment

Five processes, one database, one Redis: the website, the Core API, the
worker, and two Discord bots (Xenon Guardian and Xenon Link). Nothing here
needs a Kubernetes cluster; a single small VM runs all of it comfortably.
`infrastructure/docker/compose.yml` runs them as separate containers with
per-service env files in `infrastructure/env/`; the full split, Discord
Developer Portal setup, migration and rollback are in
[TWO_BOT_MIGRATION.md](TWO_BOT_MIGRATION.md).

---

## What you need first

| Thing                | Notes                                                       |
| -------------------- | ----------------------------------------------------------- |
| PostgreSQL 18        | Managed is fine. The app is the only writer.                |
| Redis 8              | Queue, rate limits, replay cache. Persistence not required. |
| Node.js 24.21.x      | `.nvmrc` pins it.                                           |
| A domain with TLS    | Cookies are `secure`; HSTS is sent in production.           |
| Cloudflare R2        | Bucket plus a public base URL.                              |
| Cloudflare Turnstile | Site key and secret.                                        |
| Discord application  | See [DISCORD_SETUP.md](DISCORD_SETUP.md).                   |

---

## 1. Configuration

Copy `.env.example` and fill it. Production **will not start** without these,
by design — the config layer refuses rather than running degraded:

```dotenv
NODE_ENV=production
LOG_LEVEL=info

DATABASE_URL=postgresql://…
REDIS_URL=redis://…

AUTH_SECRET=              # openssl rand -base64 32
AUTH_DISCORD_ID=
AUTH_DISCORD_SECRET=
AUTH_URL=https://your-domain
AUTH_TRUST_HOST=true      # only behind a proxy that rewrites the origin

# Bot tokens live in infrastructure/env/guardian.env and link.env only — never
# in the web environment. See TWO_BOT_MIGRATION.md for every service's env file.
DISCORD_MODE=enabled
DISCORD_APPLICATION_ID=   # the OAuth application; must equal AUTH_DISCORD_ID
DISCORD_GUILD_ID=

R2_ACCOUNT_ID=
R2_ACCESS_KEY=
R2_SECRET_KEY=
R2_BUCKET=
R2_PUBLIC_URL=https://cdn.your-domain

TURNSTILE_SECRET=
NEXT_PUBLIC_TURNSTILE_SITE_KEY=

FIVEM_BRIDGE_SECRET=      # openssl rand -hex 32
FIVEM_SERVER_URL=http://your-fxserver:30120

HASH_PEPPER=              # openssl rand -hex 32

NEXT_PUBLIC_SITE_URL=https://your-domain

AUTH_DEV_LOGIN=false
```

`NEXT_PUBLIC_*` values are **inlined at build time**. Changing one requires a
rebuild, not a restart. So is `R2_PUBLIC_URL`'s host: `next.config.ts` adds it
to the image allow-list, and without it gallery photos and the hero poster are
refused by Next's image optimiser. Images hosted anywhere else (for example a
poster URL pasted into settings from another site) are refused the same way.

Leave `AUTH_DEV_LOGIN` false. It does nothing in production regardless — the
dev sign-in route requires a non-production `NODE_ENV` as well as the flag —
but there is no reason to set it.

---

## 2. Build

```bash
pnpm install --frozen-lockfile
pnpm db:generate
pnpm build
```

`pnpm build` produces the Next output and each service's bundled
`dist/main.js` (`apps/guardian-bot`, `apps/link-bot`, `apps/core-api`,
`apps/worker`).

---

## 3. Migrate

```bash
pnpm db:deploy
```

`migrate deploy` applies committed migrations only. It never generates or
rewrites one, so a schema change without a migration fails here rather than
being papered over as a destructive auto-migration.

Run it **before** starting the new web process, and take a backup first. A
migration that drops a column is not reversible by restarting the old build.

---

## 4. Seed

```bash
pnpm db:seed
```

Idempotent and safe on every deploy. It upserts the capability catalogue and
the default roles, and touches no community data.

**Never run `pnpm db:seed:dev` against production.** It refuses when
`NODE_ENV=production`, but it also sets `dev.fixturesLoaded`, which paints a
warning banner across the whole control centre — so if it ever does run, you
will know.

---

## 5. Start

```bash
pnpm --filter @xenon/web start            # port 3200
pnpm --filter @xenon/core-api start       # port 3300, private network only
pnpm --filter @xenon/worker start
pnpm --filter @xenon/link-bot start       # http mode: gateway on 8082, private network only; relay mode: no listener
pnpm --filter @xenon/guardian-bot start   # health on 127.0.0.1:8081
```

Under a process manager — systemd, PM2, Docker — with restart-on-failure. The
web tier and core-api are stateless; scale them horizontally if you need to.
The worker is safe to run more than once (the outbox relay uses
`FOR UPDATE SKIP LOCKED`). Run **one** Guardian and **one** Link process: a
second copy would double every Discord side effect. Guardian keeps security
configuration, trust, cases, incidents, lockdown/quarantine/raid recovery
journals, and snapshots in `.data/discord-runtime.json` (no secrets). Mount
`.data/` on a persistent volume, include it in backups, and keep the working
directory stable. The runtime enforces a single instance with
`.data/discord-runtime.json.lock`; see
[DISCORD_SETUP.md § Single instance and recovery](DISCORD_SETUP.md#single-instance-and-recovery).

---

## 6. First administrator

Granting roles needs `staff.manage`, which nobody has on a fresh install. Sign
in once with Discord, then break the deadlock from a shell with database access:

```bash
pnpm --filter @xenon/database grant-owner <your-discord-user-id>
```

The escalation path deliberately requires database access, not merely a
session.

---

## 7. Register slash commands

```bash
pnpm guardian:register   # Guardian's commands, with Guardian's credentials
pnpm link:register       # Link's commands, with Link's credentials
```

Guild-scoped, so they propagate immediately. Both bots also register their own
commands on startup, and both refuse a registry containing the other
application's command names.

---

## Reverse proxy

Terminate TLS upstream and forward to `127.0.0.1:3200`.

- Pass `X-Forwarded-For`. It is used **only hashed**, for abuse buckets and
  audit correlation, so a spoofed value costs the spoofer their own bucket.
- Pass `X-Forwarded-Proto`, or cookies will not be marked secure.
- Set `AUTH_TRUST_HOST=true` if the proxy rewrites the origin.
- Do **not** add framing headers of your own; the app sends
  `frame-ancestors 'none'` and `X-Frame-Options: DENY`.

---

## Deploy checklist

Before:

- [ ] Database backup taken and the restore path tested at least once
- [ ] Migrations reviewed — anything destructive understood
- [ ] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` green
- [ ] `pnpm build` green
- [ ] New environment variables added to the deployment target

During:

- [ ] `pnpm db:deploy`
- [ ] `pnpm db:seed`
- [ ] Restart core-api, worker, link
- [ ] Restart guardian only if its build changed (it is independent of the rest)
- [ ] `pnpm guardian:register` / `pnpm link:register` if commands changed

After:

- [ ] `/control → Health`: database, Redis, `core-api`, `worker`, `link` HEALTHY; outbox HEALTHY
- [ ] Guardian `GET 127.0.0.1:8081/healthz` → 200
- [ ] Queue `failed` count not climbing
- [ ] Sign out and back in — the OAuth round trip
- [ ] Open one application in `/control` and confirm the review card posted
- [ ] Connect to the game server once, confirm the gate ran
- [ ] **No fixtures banner** anywhere in `/control`

---

## Rolling back

Redeploy the previous build. Database migrations are **not** rolled back
automatically, and most are not reversible — which is why the backup comes
first, and why a release that changes the schema should be deployed on its own
rather than bundled with a large feature.

---

## What is still yours to configure

Nothing in this repository invents your community. Before launch, replace in
`/control`:

| Area                               | Where                                            |
| ---------------------------------- | ------------------------------------------------ |
| Discord invite                     | Settings → `community.discordInvite`             |
| Connect URL                        | Settings → `community.connectUrl`                |
| Social links                       | Settings → `community.*`                         |
| Hero video / poster                | Settings → `site.heroVideoUrl` / `heroPosterUrl` |
| Departments                        | Departments                                      |
| Rules                              | Rules                                            |
| Application questions              | Applications → Templates                         |
| Discord channels and role mappings | Discord                                          |
| Game servers                       | Game servers                                     |
| Staff and roles                    | Staff                                            |
| News and gallery                   | News, Gallery                                    |

The seeded baseline ships capabilities and default roles only. Everything above
is empty until you fill it, on purpose: guessed content is content somebody has
to find and delete later.
