# Operations

Running Xenon day to day: what to look at, what the alarms mean, and what to do
about them.

---

## The processes

| Process       | Command                          | Needs                    | If it stops                          |
| ------------- | -------------------------------- | ------------------------ | ------------------------------------ |
| Web           | `pnpm --filter @xenon/web start` | Postgres, Redis          | The site is down                     |
| Bot + workers | `pnpm --filter @xenon/bot start` | Postgres, Redis, Discord | Roles and review cards stop updating |

They are separate processes on purpose. A gateway disconnect must not take the
website down, and a deploy of the website must not drop the bot's connection.

The bot process runs both the gateway client and the job worker (concurrency 4).

---

## Health

`/control → Health` is open to any staff member — anyone holding at least one
capability — and shows:

| Panel           | Healthy looks like                 |
| --------------- | ---------------------------------- |
| Database        | Reachable, migration count matches |
| Redis           | Reachable                          |
| Heartbeats      | `bot=HEALTHY, worker=HEALTHY`      |
| Queue depth     | Waiting near zero, failed zero     |
| Game servers    | A snapshot newer than five minutes |
| Whitelist sync  | Unsynced count near zero           |
| Fixtures banner | **Absent** in production           |

A stale snapshot renders as **UNKNOWN** rather than as the last known value.
The status page never invents a player count.

### The fixtures banner

`seed-dev.ts` sets `dev.fixturesLoaded`, and every control-centre screen renders
a standing warning while it is set. If you see it in production, somebody ran
`pnpm db:seed:dev` against the live database and the content on screen is
fiction. Clear the setting only after replacing the data.

---

## Queue

One BullMQ queue, `xenon`, with a typed job catalogue.

| Job                     | Attempts | Backoff | Collapses on |
| ----------------------- | -------- | ------- | ------------ |
| `discord.review.post`   | 8        | 5 s     | submission   |
| `discord.review.update` | 8        | 5 s     | submission   |
| `discord.dm`            | 5        | 10 s    | notification |
| `discord.channel.post`  | 6        | 5 s     | —            |
| `discord.role.sync`     | 8        | 5 s     | —            |
| `discord.guild.sync`    | 3        | 30 s    | guild        |
| `fivem.whitelist.sync`  | 10       | 10 s    | —            |
| `fivem.status.poll`     | 2        | 5 s     | —            |
| `applications.expire`   | 2        | 60 s    | —            |
| `maintenance.cleanup`   | 2        | 60 s    | —            |

Jobs that collapse use a deterministic id, so a reviewer double-clicking
Approve produces one Discord message rather than two. Role and whitelist syncs
deliberately **do not** collapse: two changes in quick succession must both be
reconciled, and each run is idempotent.

A rising `failed` count is the signal worth alerting on. Rising `waiting` with
`active` at zero means the worker is not running.

---

## Routine tasks

### Deploy

See [DEPLOYMENT.md](DEPLOYMENT.md).

### Publish a ruleset

`/control → Rules`. Rules are versioned; publishing creates a new `RuleSet` and
marks it current. Players are asked to accept the current version, and
acceptance is recorded per version — so publishing resets acceptance, which is
the point.

### Open or close applications

`/control → Settings → applications.globallyOpen` closes everything at once.
Individual templates have their own status and an opens/closes window.

### Sanction an account

`/control → Players → <player>`. Requires `players.ban`. Sessions are deleted
immediately; Xenon roles are kept so the sanction is reversible, but mapped
Discord roles are stripped, because that is what people can see.

The account can still file an appeal. An appeal process a banned player cannot
reach is not an appeal process.

### Rotate the FiveM bridge secret

1. Generate a new secret.
2. Update `server.cfg` and restart the resource.
3. Update `FIVEM_BRIDGE_SECRET` and restart the web tier.

There is a window between the two where the gate fails open and logs it. Doing
it in the other order fails closed and refuses everybody, which is worse.

### Rotate `HASH_PEPPER`

Don't, casually. Existing IP hashes become uncorrelatable with new ones —
historical abuse investigation silently stops working. If you must, record the
date so the discontinuity is explicable later.

---

## Incidents

### Discord is down

Nothing to do. Approvals, whitelists and notifications all still work; the
portal notification is the record and the DM is a projection of it. Jobs retry.
Expect the `failed` count to rise and then drain.

Do **not** replay by re-approving. The approval already committed.

### Redis is down

- Rate limiting fails open — the site works, abuse controls are off.
- Bridge replay defence falls back to signature and timestamp, and logs it.
- Jobs cannot be enqueued. Side effects are lost, not queued.

That last one is the real cost: role changes and whitelist pushes made during
the outage will not reconcile by themselves. After recovery, re-run a sync from
`/control → Discord` and `/control → Game servers`.

### Postgres is down

Everything is down. There is no degraded mode, deliberately — serving stale
authorization decisions is worse than serving an error.

### The game server is unreachable

Xenon marks the snapshot stale and the status page says **UNKNOWN**.
`fivem.whitelist.sync` retries ten times. Nothing needs doing.

### The website is unreachable

The connect gate **fails open** and logs it. Players get in unchecked until
Xenon returns; state is re-checked on every connect, so the gate closes again
by itself. See [FIVEM_SETUP.md](FIVEM_SETUP.md) for how to invert that choice.

---

## Backups

Postgres is the only thing that must be backed up. Redis holds rate-limit
windows, the replay cache and the queue — all reconstructible.

Restore drill, at least once before you need it:

```bash
pg_dump   "$DATABASE_URL" > xenon-$(date +%F).sql
psql      "$RESTORE_URL"  < xenon-2026-09-22.sql
pnpm db:deploy     # bring the restored copy up to the current migration
```

Uploaded media lives in R2 and has its own lifecycle. A database restore
without the matching bucket leaves broken media references.

---

## Logs

Structured JSON via pino, redacted centrally. `LOG_LEVEL` controls verbosity;
`debug` in development, `info` in production.

Things worth grepping:

| Prefix           | Means                                                |
| ---------------- | ---------------------------------------------------- |
| `[jobs]`         | Enqueue failures — usually Redis                     |
| `[bridge]`       | Bridge verification, including replay-cache fallback |
| `[xenon_bridge]` | The game server's own log, not Xenon's               |

---

## Scheduled work

| Job                   | Does                                                                          |
| --------------------- | ----------------------------------------------------------------------------- |
| `applications.expire` | Moves stale submissions to `EXPIRED`                                          |
| `maintenance.cleanup` | Prunes spent link tokens, lifts expired suspensions, expires role assignments |
| `fivem.status.poll`   | Refreshes the status snapshot                                                 |

These are enqueued by the bot process. If the bot is not running, none of them
happen — which is the most common explanation for "why is this application
still open".
