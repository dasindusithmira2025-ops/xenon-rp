# Single-instance dual-bot hosting (CyberNex)

`scripts/start-bots.mjs` runs both Discord bots as separate Node.js child
processes under one foreground supervisor. Node built-ins only: no Docker, no
process manager, no extra server, no public port.

| Bot                | Workspace             | Entrypoint (cwd = app dir) | Env file           | Loopback port                                      |
| ------------------ | --------------------- | -------------------------- | ------------------ | -------------------------------------------------- |
| Guardian           | `@xenon/guardian-bot` | `src/main.ts` via `tsx`    | `.env.guardian`    | 8081 health                                        |
| Integration (Link) | `@xenon/link-bot`     | `src/main.ts` via `tsx`    | `.env.integration` | none in `relay` mode (8082 gateway in `http` mode) |

The integration bot is **Xenon Link** (whitelist, identity/Cfx.re linking,
role sync, status, staff review). Guardian responsibilities stay in Guardian;
see [TWO_BOT_MIGRATION.md](TWO_BOT_MIGRATION.md).

> **Workspace rename.** The production command in use today filters
> `@xenon/bot`. In this checkout that workspace is `@xenon/guardian-bot`
> (`apps/bot` no longer exists). The old command stops working once this
> revision is deployed; that is why rollback below pins the previous revision.

## Hard dependency of the integration bot: Core API

Link holds no database or Redis credential. Everything it does goes through
`core-api` (`CORE_API_URL`). Neither `core-api` nor the `worker` runs inside
this single instance: host `core-api`, `worker`, Postgres and Redis elsewhere
before expecting the integration bot to do real work.

Link connects to Discord without Core, but it registers its slash commands only
once Core answers (`status.board`), retrying with backoff. Commands registered
earlier stay in place and answer "temporarily unavailable" while Core is down;
a first start with Core down advertises no whitelist or identity command.

## Reaching Link from the worker: the relay

The gateway listener is loopback-only, so a `worker` on another machine cannot
call it. Instead of a tunnel, set **`LINK_GATEWAY_MODE=relay`** (in
`.env.integration` and in the worker's env). Then:

- Link opens **no listening socket** and no inbound port is needed.
- The worker signs each gateway request with `LINK_GATEWAY_SECRET` exactly as
  before and parks it in Redis. Link pulls it from Core over outbound HTTPS
  (`relay.pull`, a long-poll of up to 20 s, signed with `LINK_CORE_SECRET`),
  verifies the worker signature itself, runs it through the same handlers, and
  posts the result back (`relay.complete`). Core reports the monotonic time
  through the start of the Redis claim call, a conservative boundary that
  includes claim-response latency in Link's transit debit without counting
  Core's long-poll wait against a fresh request.
- `CORE_API_URL` must be a URL this host can reach (for example
  `https://core.your-domain`). Core and the worker must use the same Redis. A
  proxy in front of Core must not buffer or cut responses held open ~30 s.
- `LINK_GATEWAY_SECRET` is still required in Link (it verifies the envelopes).
  Neither Core nor Redis holds it, so they can carry requests but not forge
  them.
- A single claimed envelope executes at most once. **Job delivery is still
  at-least-once:** if Link has already started a Discord REST operation when
  the worker times out, its outcome may be unknown and a job retry may repeat
  the side effect. This is the same timeout ambiguity as the direct HTTP mode,
  not exactly-once delivery. Monitor retry/error logs; do not treat message
  sends as deduplicated transactions.

The worker's `link` heartbeat reads the presence Core records on every pull:
healthy while Link pulls with Discord ready, degraded while Discord is not
ready, unhealthy when Link has not pulled for 30 s.

Cut-over: deploy Core, the worker and Link with the new code (the default
`http` behaves as before), then set `LINK_GATEWAY_MODE=relay` in the worker env
and `.env.integration` and restart both. During the gap the worker gets fast
retryable errors and jobs retry. Roll back by setting `http` on both.

## Environment files

Create both at the repository root. They are git-ignored (`.env.*`). Start from
the examples and `chmod 600` them:

```
cp infrastructure/env/guardian.env.example .env.guardian
cp infrastructure/env/link.env.example     .env.integration
chmod 600 .env.guardian .env.integration
```

The supervisor passes each child **only** the keys below plus non-secret system
variables (`PATH`, `HOME`, `TMPDIR`, `TZ`, proxy variables, …). Panel
environment variables and the other bot's file are never forwarded.

### `.env.guardian`

| Variable                          | Required | Notes                                              |
| --------------------------------- | -------- | -------------------------------------------------- |
| `GUARDIAN_DISCORD_TOKEN`          | yes      | Guardian application bot token (secret)            |
| `GUARDIAN_DISCORD_APPLICATION_ID` | yes      | snowflake                                          |
| `DISCORD_GUILD_ID`                | yes      | snowflake                                          |
| `DISCORD_INVITE_URL`              | yes      | URL                                                |
| `NEXT_PUBLIC_SITE_URL`            | no       | ticket-panel website button                        |
| `GUARDIAN_HEALTH_HOST`            | no       | default `127.0.0.1`; must be loopback              |
| `GUARDIAN_HEALTH_PORT`            | no       | default `8081`                                     |
| `NODE_ENV`, `LOG_LEVEL`           | no       | forced to `production` / `info` (Guardian demands) |

Migrating from the current env: `DISCORD_BOT_TOKEN` → `GUARDIAN_DISCORD_TOKEN`,
`DISCORD_APPLICATION_ID` → `GUARDIAN_DISCORD_APPLICATION_ID`; drop
`BOT_RUNTIME_MODE`. Any `LINK_*` / `CORE_API_*` key is a hard error.

### `.env.integration`

| Variable                                              | Required | Notes                                                                      |
| ----------------------------------------------------- | -------- | -------------------------------------------------------------------------- |
| `LINK_DISCORD_TOKEN`                                  | yes      | Link application bot token (secret, different app)                         |
| `LINK_DISCORD_APPLICATION_ID`                         | yes      | snowflake, different from Guardian's                                       |
| `DISCORD_GUILD_ID`                                    | yes      | same guild as Guardian                                                     |
| `NEXT_PUBLIC_SITE_URL`                                | yes      | `https://…`                                                                |
| `CORE_API_URL`                                        | yes      | reachable Core API                                                         |
| `LINK_CORE_SECRET`                                    | yes      | ≥32 chars; equals `core-api` env (secret)                                  |
| `LINK_GATEWAY_SECRET`                                 | yes      | ≥32 chars; equals `worker` env; ≠ `LINK_CORE_SECRET`                       |
| `LINK_GATEWAY_MODE`                                   | no       | `http` (default) or `relay`; use `relay` here (see above)                  |
| `LINK_GATEWAY_HOST`, `LINK_GATEWAY_PORT`              | no       | `http` mode only: default `127.0.0.1:8082`, loopback; unchecked in `relay` |
| `LINK_EVENTS_CHANNEL_ID`, `LINK_STAFF_LOG_CHANNEL_ID` | no       | snowflakes                                                                 |
| `NODE_ENV`                                            | no       | forced to `production`                                                     |
| `LOG_LEVEL`                                           | no       | default `info`                                                             |

`GUARDIAN_*`, `DATABASE_*`, `REDIS_*`, `AUTH_*` keys are hard errors.

## Startup command

Install dependencies as a staging/deploy step, not in the long-running startup
command:

```
npx --yes pnpm@10.26.2 install --frozen-lockfile
```

**CyberNex startup command:**

```
node scripts/start-bots.mjs
```

`node` must be ≥ 24.17 (the script refuses to run below 24). Run it as the
panel's foreground process; do not wrap it in `npx pnpm … exec`, `nohup` or
`&`, which add intermediate processes that can swallow signals.

## Safeguards

- **Isolation:** exact-key env per child; cross-bot keys, equal tokens, equal
  application IDs, a token whose embedded ID belongs to the other application,
  equal ports (`http` mode), and non-loopback listen hosts all abort before
  launch.
- **No secret output:** diagnostics name keys only; every child log line has
  both bots' secret values replaced with `[redacted]`.
- **Duplicates:** `.data/start-bots.lock` refuses a second supervisor. Guardian
  keeps its own `.data/discord-runtime.json.lock`. In `http` mode Link's gateway
  port is bound before login, so a second Link exits on `EADDRINUSE`. In `relay`
  mode Link has no port, so the supervisor lock is the only guard. Two Link
  pollers would still never run one worker request twice (Core's claim is
  atomic), but both would connect to Discord, so never start a second Link by
  hand.
- **Orphans:** children watch an IPC channel to the supervisor and shut down
  when it disappears (even on `SIGKILL`). On Linux, a crashed supervisor's
  leftover child PIDs (recorded with process start time, immune to PID reuse)
  are terminated on the next start.
- **Failures:** each child restarts independently with exponential backoff
  (2 s → 60 s; reset after 60 s healthy). 8 failures in 10 min exhausts the
  budget. Guardian exhausted: everything stops, exit 1 (the host's restart
  policy takes over). Integration exhausted: Guardian keeps protecting the
  server, a `giving up` error is logged, exit code becomes 1 on shutdown.
- **Shutdown:** `SIGINT`/`SIGTERM`/`SIGHUP` is forwarded as `SIGTERM` to both
  children; after 25 s stragglers get `SIGKILL`; a second signal kills at once.
- **Memory:** `--max-old-space-size` caps V8 old space at 1536 MiB (Guardian)
  and 768 MiB (Link), not total RSS. These limits leave room below CyberNex's
  4 GiB ceiling, but actual peak RSS must be measured there with both bots
  connected; this environment has no representative live workload.
- **Persistence untouched:** Guardian still resolves `.data/discord-runtime.json`
  from the workspace root, and runs from `apps/guardian-bot` as before. Its
  runtime-store implementation is byte-identical to the prior `apps/bot`
  implementation in this checkout. Production data compatibility is not proven
  until the backed-up live file passes the read-only check below.
- **Independent registrations:** the supervisor registers nothing. Each bot
  registers its own guild commands on startup against its own application, and
  `assertCommandOwnership` still rejects a name owned by the other bot.

## CyberNex compatibility checks

Run these in the CyberNex console before cut-over:

| Check                          | Command                                                                                                                       | Needed because                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Full Node/Linux check          | `node scripts/verify-hosting.mjs`                                                                                             | Node, outbound HTTPS/WebSocket, loopback, children, disk, SIGTERM |
| Node version                   | `node -v`                                                                                                                     | ≥ 24.17                                                           |
| Outbound HTTPS                 | `curl -sI https://discord.com/api/v10/gateway`                                                                                | Gateway needs outbound 443 only                                   |
| Loopback listen allowed        | `node -e "require('net').createServer().listen(8099,'127.0.0.1',function(){console.log('ok');this.close()})"`                 | Guardian health only in relay mode                                |
| Multiple child processes       | `node -e "const {spawn}=require('child_process');spawn(process.execPath,['-e','0']).on('exit',c=>console.log('spawn ok',c))"` | supervisor spawns two children                                    |
| Writable `.data/`              | `mkdir -p .data && touch .data/.w && rm .data/.w`                                                                             | locks and Guardian runtime store                                  |
| Persistent disk across restart | note a file's mtime in `.data/` before and after a restart                                                                    | Guardian state must survive restarts                              |
| Process/memory limit           | `ulimit -u; free -m` (if available)                                                                                           | 3 Node processes; measure RSS below the 4 GiB cap                 |
| Panel signal delivery          | stop a staging instance; confirm `shutting down (SIGTERM)` and `stopped`                                                      | graceful stop on actual provider                                  |

The script checks process signal forwarding using fake children; the panel
signal test separately confirms CyberNex sends the signal to the foreground
supervisor. It never reads bot env files, contacts an authenticated Discord
endpoint, or starts either real bot. It requires Node ≥ 24.17 and Linux for the
full SIGTERM result.

If the host forbids loopback listening or extra child processes, the dual-bot
model cannot run on this plan; report back rather than patching bots.

## Deployment procedure (needs explicit approval; nothing here has been run)

1. **Backup:** copy `.data/` (especially `discord-runtime.json`) and the
   current env/startup configuration. Record the currently deployed git SHA.
2. **Validate the backup read-only:** on the staged checkout, run
   `cd apps/guardian-bot && node --import tsx src/scripts/verify-state.ts <backup>/discord-runtime.json`.
   It copies the file to a temporary directory, loads every guild through
   Guardian's actual runtime-store validator, and prints counts only. Exit 0
   means the file is readable by this implementation; it does not prove live
   Discord resources still exist. Do not proceed on a validation error.
3. **Prepare** the Link application in the Developer Portal
   ([TWO_BOT_MIGRATION.md](TWO_BOT_MIGRATION.md#xenon-link--a-new-application)):
   no privileged intents, invite, role hierarchy.
4. **Stage code** in a new directory (not over the live one): deploy this
   revision and run `npx --yes pnpm@10.26.2 install --frozen-lockfile`.
   CyberNex needs the complete monorepo checkout and frozen install (including
   both bot workspaces, packages, scripts and lockfile). The external platform
   needs updated `apps/core-api` and `apps/worker`, `packages/contracts`,
   `packages/jobs`, `packages/config`, plus its existing database/Redis services.
   Copy live `.data/` into the staged checkout **only at cut-over**, never while
   both copies run.
5. **Write** `.env.guardian` and `.env.integration` (tables above), `chmod 600`.
   On the external worker set `LINK_GATEWAY_MODE=relay` and
   `LINK_GATEWAY_SECRET` equal to Link's value. On Core set `LINK_CORE_SECRET`
   equal to Link's value. No database/Redis credentials go in either bot file.
6. **Dry validation** (the old Guardian may still be running, hence
   `--skip-ports`): `node scripts/start-bots.mjs --check --skip-ports`.
   Optionally `--verify-discord` authenticates both tokens over REST without a
   gateway session or application changes.
7. **Cut-over window:** after explicit approval, stop old Guardian from the
   panel; copy `.data/` if needed; run `node scripts/verify-hosting.mjs` on
   CyberNex Linux (required Node version); then
   `node scripts/start-bots.mjs --check` (Guardian port probe must pass), set
   the startup command above and start.
8. **Verify** the checklist below, including relay presence, both gateway
   sessions, Guardian workflows, restart isolation and RSS under 4 GiB.

For a lower-risk first step, run `--only guardian` for one restart cycle to
prove the supervisor with the existing bot alone, then switch to both.

## Rollback

1. Stop the instance from the panel (graceful; both bots exit, lock released).
2. Restore the previous production revision. **Verified repository candidate:**
   `92e05d1253e50ad080d78417fec02cc2c7ffec2e` contains the `@xenon/bot`
   workspace and `apps/bot/src/main.ts`'s `BOT_RUNTIME_MODE=discord-only`
   branch. Confirm the CyberNex deployment SHA matches this baseline before
   using it; the provider's live revision was not accessible during preparation.
3. Restore the old startup command:
   `npx --yes pnpm@10.26.2 --filter @xenon/bot exec tsx src/main.ts`
   and the old env names (`DISCORD_BOT_TOKEN`, `BOT_RUNTIME_MODE=discord-only`).
4. Keep `.data/` as it is: the runtime-store format is unchanged. If
   `.data/start-bots.lock` remains, delete it.
5. Start. Guardian state, commands and tickets come back from `.data/`. The
   Link application can stay invited and idle, or be removed in the portal.

## Operational checklist

- [ ] `node -v` ≥ 24.17; all compatibility checks above pass.
- [ ] `.env.guardian`, `.env.integration` exist, mode 600, not committed.
- [ ] `node scripts/start-bots.mjs --check` prints `OK … configuration valid`.
- [ ] Log shows `[guardian] started`, `[integration] started`, two different PIDs.
- [ ] Guardian: `/xenon status` replies; `/security status` unchanged; a test
      join produces the welcome; a ticket opens.
- [ ] Integration: `/status`, `/profile`, `/whitelist`, `/link` respond (needs
      Core API reachable).
- [ ] Each application's command list contains only its own commands.
- [ ] Logs never show a token or secret value (only `[redacted]` if one is ever printed).
- [ ] Kill one child (`kill <pid>`): it restarts with backoff, the other never restarts.
- [ ] Panel stop: log ends with `[supervisor] stopped`; no `node` processes remain.
- [ ] Panel restart: no `another supervisor is already running`.
