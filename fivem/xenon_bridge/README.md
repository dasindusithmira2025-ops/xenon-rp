# xenon_bridge

The FiveM half of XenonRP. It gates connections on the whitelist Xenon holds,
redeems account link codes, and answers Xenon's signed requests for status.

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
   ensure xenon_bridge
   ```

   Use `set`, never `setr`. A `setr` convar is replicated to every client, and
   the secret is what proves a request came from your server.

4. In Xenon, under Control → Integrations → Game servers, set the server's
   adapter to match your framework and its bridge endpoint to this server's
   HTTP address.

## Behaviour when Xenon is unreachable

Connections are admitted, and the reason is logged.

This is a deliberate choice. The alternative - refusing everybody - means a
website outage empties the city, which is worse and more visible than a few
unwhitelisted connections during a few minutes of downtime. Whitelist state is
checked on every connect, so the gate closes again the moment Xenon returns.

To fail closed instead, change the `deferrals.done()` call in the
`Xenon unreachable` branch of `src/server.ts` to pass a message. Make that
choice knowingly.

## Framework support

Nothing here is framework-specific. Standalone, QBCore, QBX and ESX all work
without changes, because the bridge only ever answers "is this identifier
allowed in" and never touches a character, an inventory or a job.

Framework-specific work - granting a job on approval, for example - belongs in
your own resource, triggered from the events this one already handles.
