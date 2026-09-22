# FiveM setup

The game server asks Xenon who may play. It never decides.

`fivem/xenon_bridge` holds no whitelist file, no player table and no cached
state — it asks on every connection, which is why a revocation takes effect at
the next connect rather than at the next restart.

---

## What the bridge does

| Direction    | Endpoint                     | Purpose                       |
| ------------ | ---------------------------- | ----------------------------- |
| Game → Xenon | `POST /api/bridge/whitelist` | The connect gate              |
| Game → Xenon | `POST /api/bridge/link`      | Redeeming a link code         |
| Game → Xenon | `POST /api/bridge/presence`  | Pushed player counts          |
| Xenon → Game | `POST /xenon/status`         | Polled player counts          |
| Xenon → Game | `POST /xenon/whitelist`      | Whitelist change notification |
| Xenon → Game | `POST /xenon/presence`       | "Is this identifier online?"  |

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

The player proves they hold both the Xenon session and the FiveM client:

1. In the portal, **Account → FiveM**, they generate a code — `XEN-7K4P9`.
2. In game, they type `/link XEN-7K4P9`.
3. The bridge sends the code **plus the identifiers FXServer observed**.
4. Xenon redeems the code and binds those identifiers to that account.

The identifiers come from the game server, never from the player. A
self-declared licence would let anyone claim anyone's account.

Properties of the code, and where each is enforced:

| Property      | How                                                            |
| ------------- | -------------------------------------------------------------- |
| Unguessable   | 5 characters from a 31-symbol alphabet, drawn with `randomInt` |
| Short-lived   | 10 minutes                                                     |
| Single use    | Consumed inside the redeeming transaction                      |
| Rate limited  | 5 per 15 minutes per user                                      |
| Not in a dump | Only the SHA-256 is stored; the code is shown once             |

The alphabet omits `0/O`, `1/I/L` and friends, because these get read aloud in
voice chat and typed from screenshots.

Expired, reused, revoked and unknown codes all produce the **same** message.
Distinguishing them would turn the endpoint into an oracle for guessing live
codes.

An identifier already bound to a different account is refused rather than
moved. One Steam account cannot be two players; that case needs a support
ticket and a human.

---

## When Xenon is unreachable, the gate fails **open**

Connections are admitted and the reason is logged.

This is deliberate. The alternative — refusing everybody — means a website
outage empties the city, which is a worse and far more visible failure than a
handful of unwhitelisted connections during a few minutes of downtime.
Whitelist state is re-checked on every connection, so the gate closes again the
moment Xenon returns.

To fail closed instead, change the `deferrals.done()` call in the
`Xenon unreachable` branch of `fivem/xenon_bridge/src/server.ts` to pass a
message. Make that choice knowingly.

---

## Troubleshooting

| Symptom                                   | Cause                                                               |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `[xenon_bridge] Not configured`           | `xenon_endpoint` unset, or the secret is under 32 characters        |
| Everyone gets in regardless of whitelist  | Bridge unconfigured, or Xenon unreachable — check the log           |
| `/link` says "not valid" for a fresh code | Clock skew over 5 minutes between the two machines                  |
| Bridge endpoints return 401               | Secrets differ between `.env` and `server.cfg`                      |
| Bridge endpoints return 503               | `FIVEM_BRIDGE_SECRET` is empty on the Xenon side                    |
| Bridge endpoints return 409               | Replayed nonce — usually a retry storm, not an attack               |
| Status page shows **unknown**             | No snapshot within five minutes; Xenon says so rather than guessing |

The signing scheme is duplicated in the resource, because it runs outside the
workspace and cannot import `@xenon/fivem`. A golden vector in
`packages/fivem/src/signing.test.ts` pins the exact signed bytes, so changing
one side fails a test rather than silently locking the game server out. If you
change the scheme, change both files and that vector together.
