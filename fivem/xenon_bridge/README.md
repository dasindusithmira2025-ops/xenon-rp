# xenon_bridge

The FiveM half of XenonRP. It gates connections on the whitelist Xenon holds,
keyed on the player's `fivem:` (Cfx.re account) identifier that they verified on
the Xenon website — there is no in-game linking command. It also answers
Xenon's signed requests for status and forwards gameplay events (joins, drops,
txAdmin restarts and bans) to Xenon.

It owns no state. There is no local whitelist file and no player table: Xenon
is the source of truth, and this resource is the part of it that runs on the
game server.

## Install

1. Build once, from the monorepo root:

   ```
   pnpm --filter @xenon/fivem-bridge build
   ```

2. Copy this whole folder (including `dist/`) into your server's `resources`
   directory.

3. In `server.cfg`:

   ```
   set xenon_endpoint "https://your-xenon-site"
   set xenon_secret   "the same value as FIVEM_BRIDGE_SECRET"
   set xenon_slug     "xenon-main"
   set xenon_fail_mode "open"   # or "closed"; see below
   ensure xenon_bridge
   ```

   `xenon_slug` must match the server's slug in Xenon: events for an unknown
   slug are rejected.

   Use `set`, never `setr`. A `setr` convar is replicated to every client, and
   the secret is what proves a request came from your server.

4. In Xenon, under Control → Integrations → Game servers, set the server's
   adapter to match your framework and its bridge endpoint to this server's
   HTTP address.

## Behaviour when Xenon is unreachable

Controlled by the `xenon_fail_mode` convar, logged at startup:

- `open` (default, and the historical behaviour): the player is admitted and
  the reason is logged. A website outage then cannot empty the city; whitelist
  state is checked on every connect, so the gate closes again the moment Xenon
  returns.
- `closed`: the player is refused with "Xenon is temporarily unavailable. Try
  again in a minute." Use this when an unwhitelisted connection is worse than
  downtime.

Any other value is treated as `closed` and logged as unrecognised. Both modes
apply when the whitelist call fails (network error, timeout, non-2xx) or the
check throws. An unconfigured bridge (no endpoint or secret) does not gate at
all, whatever the mode.

The connect check admits by the `fivem:` (Cfx.re account) identifier the player
verified on the Xenon website, plus Rockstar licences proven earlier or granted
by staff (see docs/CFX_LINKING.md). Discord, Steam, Xbox and Live ids are
client-reported and never admit anyone.

## Events forwarded to Xenon

Each is a signed `POST /api/bridge/events` with a fresh UUID `eventId` (Xenon's
idempotency key) and `serverSlug` = `xenon_slug`. Delivery is best-effort: a
failure is logged and dropped, never blocks gameplay and never retries in a
loop.

| FXServer / txAdmin event          | Xenon event                |
| --------------------------------- | -------------------------- |
| `playerJoining`                   | `PLAYER_CONNECTED`         |
| `playerDropped` (reason)          | `PLAYER_DISCONNECTED`      |
| `txAdmin:events:scheduledRestart` | `SERVER_RESTART_SCHEDULED` |
| `txAdmin:events:playerBanned`     | `PLAYER_BANNED`            |

All handlers are registered with `on` (server-local), never `onNet`. txAdmin
events whose `source` is a player are ignored, so a client cannot fake a ban or
a restart. Player identifiers are always read server-side with
`GetPlayerIdentifier`; ban identifiers come from txAdmin's own server-side
payload.

### txAdmin bans

txAdmin enforces its own bans in its own `playerConnecting` handler. Xenon
records a txAdmin ban as a FiveM-scope moderation case (and announces it) but
does not change the player's Xenon account, and Xenon never overrides a txAdmin
rejection: a player txAdmin refuses stays refused even if Xenon would admit
them.

## Framework support

Nothing here is framework-specific. Standalone, QBCore, QBX and ESX all work
without changes, because the bridge only ever answers "is this identifier
allowed in" and never touches a character, an inventory or a job.

Framework-specific work - granting a job on approval, for example - belongs in
your own resource, triggered from the events this one already handles.

## Development

```
pnpm --filter @xenon/fivem-bridge typecheck
pnpm --filter @xenon/fivem-bridge test
pnpm --filter @xenon/fivem-bridge build
```
