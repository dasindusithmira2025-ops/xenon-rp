# FiveM setup

The game server asks Xenon who may play. It never decides.

`fivem/xenon_bridge` holds no whitelist file, no player table and no cached
state — it asks on every connection, which is why a revocation takes effect at
the next connect rather than at the next restart.

---

## What the bridge does

| Direction    | Endpoint                     | Purpose                                       |
| ------------ | ---------------------------- | --------------------------------------------- |
| Game → Xenon | `POST /api/bridge/whitelist` | The connect gate                              |
| Game → Xenon | `POST /api/bridge/presence`  | Pushed player counts                          |
| Game → Xenon | `POST /api/bridge/events`    | Connect/drop, txAdmin restart and ban notices |
| Xenon → Game | `POST /xenon/status`         | Polled player counts                          |
| Xenon → Game | `POST /xenon/whitelist`      | Whitelist change notification                 |
| Xenon → Game | `POST /xenon/presence`       | "Is this identifier online?"                  |

Every request in both directions is HMAC-signed. See [SECURITY.md](SECURITY.md).

---

## 1. Shared secret

Generate one and put the **same value** on both sides:

```bash
openssl rand -hex 32
```

```dotenv
# Xenon .env
FIVEM_BRIDGE_SECRET=<the value>
FIVEM_SERVER_URL=http://127.0.0.1:30120
```

Leaving `FIVEM_SERVER_URL` empty runs the mock adapter, which exercises the
whole sync path with no FXServer anywhere. Leaving `FIVEM_BRIDGE_SECRET` empty
makes the bridge endpoints return 503 — they do not exist with authentication
disabled.

## 2. Build and install the resource

```bash
pnpm --filter @xenon/fivem-bridge build
```

Copy the whole `fivem/xenon_bridge` folder, including `dist/`, into your
server's `resources` directory. There is no install step on the game box — the
resource is bundled into a single file precisely so you never need pnpm there.

## 3. server.cfg

```cfg
set xenon_endpoint "https://your-xenon-site"
set xenon_secret   "the same value as FIVEM_BRIDGE_SECRET"
set xenon_slug     "xenon-main"

ensure xenon_bridge
```

> **`set`, never `setr`.** A `setr` convar is replicated to every connected
> client. The secret is the only thing proving a request came from your server;
> publishing it to players hands them the ability to whitelist themselves.

`xenon_slug` must match the server's slug in `/control → Game servers`.

## 4. Configure the server in Xenon

`/control → Game servers`:

- **Slug** — matches `xenon_slug`
- **Adapter** — `STANDALONE`, `QBCORE`, `QBX`, `ESX`, or `MOCK`
- **Endpoint URL** — where Xenon can reach the FXServer HTTP port
- **Connect URL** — the `cfx.re/join/...` code shown to players
- **Max players**, **restart cron**, **timezone**

The adapter kind does not change the protocol. Nothing in the bridge knows or
cares which framework you run, because it only ever answers "is this identifier
allowed in" — it never touches a character, an inventory or a job. The adapter
exists for framework-specific work _you_ add, triggered from the events the
bridge already handles.

---

## Account linking

Players link their **Cfx.re account on the website** before they are
whitelisted — there is no in-game step. **Account → Connect Cfx.re** sends them
to forum.cfx.re to approve Xenon; Xenon reads the numeric Cfx.re account id,
which is exactly the `fivem:<id>` identifier FXServer reports, and binds it to
their Xenon account. The full protocol, threat model and staging checks are in
[CFX_LINKING.md](CFX_LINKING.md).

At connect time the bridge sends the identifiers FXServer read itself. Only the
`fivem:` identifier admits a player, plus Rockstar licences proven by the
retired in-game code flow (`FIVEM_ADMISSION_MODE=cfx-or-legacy`, the default)
or granted by staff as an exception. Client-reported `discord:`, `steam:`,
`xbl:` and `live:` identifiers never admit anyone. Identifiers that resolve to
more than one Xenon account are refused with "Identity conflict — contact
staff".

A player whose client reports no `fivem:` identifier is told to sign in to
Cfx.re in FiveM (Settings → Account) and reconnect. If that is impossible, staff
with `players.manage` can add the player's Rockstar licence as an audited
exception with `POST /api/v1/players/<XN-id>/licence-exception`
(`{"licence": "<40 hex chars>", "reason": "…"}`). There is no control-centre
button for this yet.

---

## When Xenon is unreachable: `xenon_fail_mode`

By default (`set xenon_fail_mode "open"`, or unset) connections are admitted
and the reason is logged. A website outage then never empties the city, and the
gate closes again the moment Xenon returns because whitelist state is
re-checked on every connection.

`set xenon_fail_mode "closed"` refuses connections with "Xenon is temporarily
unavailable" while Xenon cannot be reached. Any other value is treated as
`closed` and logged, so a typo cannot quietly open the gate. Make the choice
knowingly.

Only an outage counts as "unreachable": no response or a 5xx. When Xenon
answers and refuses the check itself — a wrong `xenon_secret`, a replayed or
malformed request, an exhausted rate limit — the player is refused in either
mode, so a misconfiguration or a flood of reconnects can never open the gate.

## txAdmin

txAdmin enforces its own bans in its own `playerConnecting` handler; Xenon
never overrides a txAdmin rejection. The bridge forwards
`txAdmin:events:scheduledRestart` (a restart notice in Link's events channel)
and `txAdmin:events:playerBanned` (a FiveM-scope moderation case in Xenon,
visible to staff; it does not change the Xenon account). Both are listened to as
server-local events only, and events raised by a player are ignored.

---

## Troubleshooting

| Symptom                                  | Cause                                                               |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `[xenon_bridge] Not configured`          | `xenon_endpoint` unset, or the secret is under 32 characters        |
| Everyone gets in regardless of whitelist | Bridge unconfigured, or Xenon unreachable — check the log           |
| Bridge endpoints return 401              | Secrets differ between `.env` and `server.cfg`                      |
| Bridge endpoints return 503              | `FIVEM_BRIDGE_SECRET` is empty on the Xenon side                    |
| Bridge endpoints return 409              | Replayed nonce — usually a retry storm, not an attack               |
| Status page shows **unknown**            | No snapshot within five minutes; Xenon says so rather than guessing |

The signing scheme is duplicated in the resource, because it runs outside the
workspace and cannot import `@xenon/fivem`. A golden vector in
`packages/fivem/src/signing.test.ts` pins the exact signed bytes, so changing
one side fails a test rather than silently locking the game server out. If you
change the scheme, change both files and that vector together.
