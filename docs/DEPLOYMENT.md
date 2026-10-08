# Deployment

Two processes, one database, one Redis. Nothing here needs a Kubernetes
cluster; a single small VM runs all of it comfortably.

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

DISCORD_BOT_TOKEN=
DISCORD_APPLICATION_ID=
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
rebuild, not a restart.

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

`pnpm build` produces the Next standalone output and the bot's bundled
`dist/main.js`.

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
pnpm --filter @xenon/web start     # port 3200
pnpm --filter @xenon/bot start
```

Under a process manager — systemd, PM2, Docker — with restart-on-failure. The
web tier is stateless; scale it horizontally if you need to. Run **one** bot
process: a second one would double every Discord side effect. With
`BOT_RUNTIME_MODE=discord-only` the bot keeps security configuration, trust,
cases, incidents, lockdown/quarantine/raid recovery journals, and snapshots in
`.data/discord-runtime.json` (no secrets). Mount `.data/` on a persistent
volume, include it in backups, and keep the working directory stable. The
runtime enforces a single instance with `.data/discord-runtime.json.lock`; see
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
pnpm --filter @xenon/bot register
```

Guild-scoped, so it propagates immediately. Re-run after adding a command.

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
- [ ] Restart web
- [ ] Restart bot
- [ ] `pnpm --filter @xenon/bot register` if commands changed

After:

- [ ] `/control → Health`: database, Redis, `bot=HEALTHY, worker=HEALTHY`
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
