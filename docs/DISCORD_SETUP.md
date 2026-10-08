# XenonRP Discord integration

This guide configures the existing Xenon website and persistent Discord service
with one official XenonRP Discord Developer Application. Discord is an identity,
community, and notification integration; Xenon’s database and capability
permissions remain authoritative.

## 1. Prepare the Xenon application

In the Discord Developer Portal, open the client's existing XenonRP
application, ID `1550168431163084921`. Do not create or select a test
application. Use the OAuth Client Secret and Bot Token already supplied in the
local `.env`; never print or commit either value.

Under **OAuth2 → Redirects**, register the exact callback for every environment
that will use OAuth:

| Environment | Redirect URI                                                  |
| ----------- | ------------------------------------------------------------- |
| Development | `http://localhost:3200/api/auth/callback/discord`             |
| Production  | `https://<XENON_PRODUCTION_DOMAIN>/api/auth/callback/discord` |

Required operator action: open application `1550168431163084921`, go to
**OAuth2 → Redirects**, add exactly
`http://localhost:3200/api/auth/callback/discord`, then select **Save Changes**.
Source code cannot register a redirect on the Discord Developer Portal.

The URI must be registered on application `1550168431163084921` and match
exactly, including scheme, host, port, path, and trailing slash. Do not register
it only on a test application or on port 3000. For local development, set
`AUTH_URL` to the origin `http://localhost:3200`; Auth.js generates the callback
path `/api/auth/callback/discord`. For production, register
`https://<XENON_PRODUCTION_DOMAIN>/api/auth/callback/discord` on the same
application and set `AUTH_URL` to the production origin. Keep
`NEXT_PUBLIC_SITE_URL` on the same origin.

Xenon player login requests only the `identify` scope. Bot installation scopes
are configured separately below; do not add `email`, `guilds`, `bot`, or
`applications.commands` to the player login flow.

## 2. Configure local environment

Copy `.env.example` to `.env`, generate a new `AUTH_SECRET`, and leave Discord
disabled until the rotated values are ready. Do not commit `.env`, paste secrets
into source files, or put secrets in support messages.

```dotenv
DISCORD_MODE=enabled
AUTH_DISCORD_ID=1550168431163084921
AUTH_DISCORD_SECRET=<OAuth client secret for application 1550168431163084921>
DISCORD_APPLICATION_ID=1550168431163084921
DISCORD_BOT_TOKEN=<bot token for application 1550168431163084921>
DISCORD_GUILD_ID=1371209014372991137
DISCORD_INVITE_URL=https://discord.gg/ybev9tk87f
AUTH_URL=http://localhost:3200
NEXT_PUBLIC_SITE_URL=http://localhost:3200
```

The application ID in `AUTH_DISCORD_ID` and `DISCORD_APPLICATION_ID` must be
identical and must remain `1550168431163084921`. The web process receives the
OAuth client secret but not the bot token; the bot process receives the bot
token but not the OAuth client secret.
Neither process stores Discord OAuth access or refresh tokens. `DISCORD_MODE`
must be explicitly enabled for real integration; disabled local mode never
pretends Discord is connected. Production refuses to start with Discord
disabled or with required credentials missing.

The local infrastructure ports are PostgreSQL `5442` and Redis `6389`; preserve
the values already present in `.env.example` unless you intentionally run the
services elsewhere.

The Discord invite and channel IDs are ordinary Xenon settings, not secrets.
`DISCORD_INVITE_URL` supplies the permanent invite when **Control → Settings →
Discord invite URL** (`community.discordInvite`) is unset; a saved Control
Center setting remains the override. Set the primary review, announcement, and
log channel IDs under **Control → Discord**; a template can override the review
channel for a specific application type. Channel IDs stay with their
guild/template configuration.

## 3. Install the existing bot

In the same application, use the existing bot user and the token already
configured in `DISCORD_BOT_TOKEN`. Do not create a replacement bot or reset the
token. Under **Installation**, enable guild
installation and the `bot` and `applications.commands` scopes.

The existing bot’s integrated mode needs View Channels, Send Messages, Embed
Links, Read Message History, and Manage Roles when Xenon role mappings are
enabled. The **Discord-only runtime security controller** additionally needs:

- View Audit Log — audit-event attribution and anti-nuke correlation
- Manage Channels — create security channels during setup
- Manage Roles — edit lockdown/quarantine overwrites, contain dangerous roles,
  and optionally assign the quarantine marker
- Per-channel permission authority — `View Channels` and (in voice/stage)
  `Connect`/`Speak` for quarantine. Lockdown targets also need `Send Messages`,
  `Send Messages In Threads`, `Create Public Threads`, and `Create Private Threads`.
- Manage Messages — spam deletion and `/purge`
- Moderate Members — timeout actions
- Kick Members and Ban Members — explicit moderation commands
- Manage Server — native AutoMod setup/reconciliation

`/security scan` reports missing global bot permissions; execution also reports
channel-specific access failures instead of claiming unverified containment.
Manage Webhooks is not required: Xenon observes webhook audit events but never
changes webhooks. Do not grant Administrator. Discord moderators must have a
highest role strictly above the target for moderation actions; Xenon separately
checks the bot’s hierarchy for operations that require it.

The Discord-only runtime uses Guilds, GuildModeration, GuildMembers, and
GuildVoiceStates. GuildModeration delivers audit-log events used by anti-nuke;
GuildMembers is needed for join/leave raid signals and welcome events. It also
requests GuildMessages and MessageContent so commissioned support-ticket
transcripts can include message text and enabled spam/link protections can scan
messages. Message Content is a privileged intent. If Discord rejects it, Xenon
retries without that intent and continues in degraded mode: native AutoMod and
non-content protections remain available, custom spam/link scanning is
disabled, and support-ticket transcripts omit message text and attachments.
Enable **Bot → Privileged Gateway Intents → Message Content Intent** in the
Developer Portal for complete operation. Do not enable Guild Presences; Xenon
does not use presence data.

Enable **Bot → Privileged Gateway Intents → Server Members Intent** for the
Discord-only runtime. If Discord rejects it, join-based raid protection and
welcomes cannot operate; the startup log gives the required portal setting.
The integrated runtime separately requests GuildMembers only when a configured
welcome feature needs it.

## 3.1 Commission the Discord-only security controller

The standalone security system persists configuration, trust, incidents,
moderation cases, lockdown and quarantine patch journals, and forensic snapshots
in the existing local `.data/discord-runtime.json` file. Back up that file with
the bot’s deployment data; it contains no bot token or other secrets. No
website, PostgreSQL, or Redis process is needed for the Discord-only runtime.

After enabling the required permissions/intents, restart the existing
persistent bot process and run:

1. `/security setup` as the guild owner or an internally trusted security
   administrator. It identifies existing equivalent channels/roles and
   creates missing `#security-alerts`, `#security-audit`, `#mod-logs`, and the
   optional `Xenon Quarantine` marker role without creating duplicates. Current
   setup does not add role-wide denies; member-specific overwrites enforce
   quarantine. Older versions may have written channel overwrites for this
   role; recover legacy quarantines and inspect/remove stale overwrites manually.
2. `/security scan` and `/security status`. Resolve HIGH/CRITICAL findings,
   especially missing `Manage Roles` for overwrite containment, missing
   `Manage Channels` for security-channel setup, `BOT_MISSING_VIEW_AUDIT_LOG`,
   and public security logs. Marker-role hierarchy warnings affect labeling,
   not member-specific restriction enforcement. The scan reports findings; it
   never edits permissions.

3. `/security trust add @user level:SECURITY_ADMIN` as the guild owner. Only
   the owner can grant or revoke SECURITY_ADMIN. Manage all other trust using
   `/security trust add`, `/security trust remove`, and `/security trust list`.
4. `/security automod status`, then `/security automod sync`. Xenon changes only
   rules whose IDs are recorded as Xenon-owned; same-name collisions are
   reported and left untouched.
5. Configure `/security config channels`, `/security config raid-thresholds`
   (join thresholds plus optional `recovery_minutes` and `slowmode_seconds`),
   `/security config spam` (limits and exemptions), `/security config link-policy`
   (including domain removal), and `/security config keyword` as needed.
   Check the privacy of pre-existing log channels manually; setup does not
   rewrite their existing overwrites.
6. `/security snapshot take` to record a known-good baseline after the server is
   configured.

### Default detection behavior

- **Raid detection:** AUTO raises signals at 5/10s or 10/30s joins (warning),
  9/10s or 18/30s (raid), and 15/10s or 28/30s (critical). Window edges are
  inclusive (a join exactly 10 000 ms old still counts). When at least five
  arrivals are counted, a 60% share of accounts younger than seven days or two
  bot joins in 30 seconds strengthens an existing count-based signal; account
  age alone never triggers containment, and nobody is banned automatically. A
  member leaving and rejoining within 60 seconds raises WARNING. Every
  RAID/CRITICAL arrival is quarantined with member-specific channel overwrites;
  a configured marker role is optional. Entering RAID/CRITICAL also applies
  slowmode (default 30 s, `0` disables) to the configured lockdown text and
  announcement channels and records the prior values durably; CRITICAL can
  activate lockdown. After `recovery_minutes` (default 10) without an elevated
  join, Xenon restores slowmode only on channels still at the value it applied
  and reports others as conflicts. `/security raid-mode off` or
  `/security raid disable` releases the raid response immediately;
  `/security raid-mode on` keeps it and applies the same restrictions to
  non-owner arrivals without internal trust or marked `UNTRUSTED`. Raid
  response state survives restart; the release check runs every 60 seconds.
- **Anti-nuke:** Xenon uses Discord audit-log gateway events, which carry the
  actor, and counts each audit entry once per actor/action window. Default
  high/critical thresholds include 2/3 channel deletions, 1/2 role deletions,
  1/2 permission escalations, 2/4 bans, and 3/6 kicks within their 30–60 second
  windows. HIGH raises an alert only; CRITICAL can remove dangerous roles below
  the bot’s highest role (or time out the actor) and activate lockdown. The
  guild owner, SECURITY_ADMIN, TRUSTED_STAFF, and members above XenonBot are
  never contained. Without `View Audit Log`, Xenon still counts guild-wide
  channel deletions (3/60s), role deletions (2/60s), and bans (5/60s) and
  raises an alert-only incident with attribution `UNAVAILABLE`; it never
  guesses the actor or contains anyone in that mode. Audit events arrive after
  Discord accepts the action; Xenon cannot prevent that initial mutation or
  recreate deleted Discord objects.
- **Spam and links:** Custom scanning defaults to 7 messages/8s, 3 identical or
  near-identical messages (≥ 85% similar, 12+ characters), 2 invite-bearing
  messages/30s, 6 mentions, 4 links/30s, 20 emoji, and activity across 4+
  channels. Responses escalate Observe → Warn → Delete → Timeout (10 minutes,
  1 hour, 6 hours for repeat offenders) → Staff escalation (HIGH incident in
  `#security-alerts`). After an automatic case, further detections for the
  same member within 15 s only delete messages, so one burst creates one case.
  Link warnings DM a member at most once per minute. Link policy defaults to
  WARN; Discord invites are blocked. URL checks are local heuristics, not
  reputation or malware scanning. Spam role/channel exemptions skip only the
  custom spam detector; they do not exempt those users from LinkGuard or native
  AutoMod rules. Spam never bans.
- **Native AutoMod:** Xenon reconciles three identified rules: mention spam,
  invite links, and security keywords. It leaves same-name rules with unknown
  ownership untouched. Add at most 98 custom keywords; two baseline phrases
  use Discord’s 100-keyword limit.
- **Trust:** The guild owner is the implicit OWNER level and is shown first in
  `/security trust list`; it cannot be assigned. The guild owner,
  SECURITY_ADMIN, and TRUSTED_STAFF are exempt from anti-nuke detection.
  NORMAL_STAFF is not. Discord Administrator alone grants no Xenon authority:
  privileged commands require both the specific Discord permission and the
  corresponding Xenon trust level.
- **Alerts:** Every incident is persisted. Repeated alerts with the same
  source, rule, and actor are posted at most once per 60 s (10 s for CRITICAL);
  the next posted alert lists the suppressed count and incident IDs. A higher
  severity is never suppressed.
- **Persistence:** Configuration, trust, cases, incidents, lockdown and
  quarantine journals, raid response state, and the last five guild snapshots
  survive restart. Detector rolling windows are process-local; incidents remain
  durable.

Available security controls include `/security raid status|enable|disable`,
`/security raid-mode on|off|auto`, `/security quarantine`, `/security
unquarantine`, `/security lockdown`, `/security unlock`,
`/security snapshot take|list|compare|restore-permissions`, and
`/security incident list|view|resolve`. Manual controls require both the
command’s Discord permission and Xenon’s internal trust level.
`/warn`, `/warnings`, `/timeout`, `/untimeout`, `/kick`, `/ban`, `/unban`,
`/softban`, `/purge`, `/case`, and `/cases` use persistent case IDs. They check
the moderator’s and XenonBot’s hierarchy and permissions, reject a repeat of
the same action on the same target while one is in flight or within 15 s,
reject banning an already-banned user, unbanning a user who is not banned, and
removing a timeout that does not exist, and record no case when Discord rejects
the action. Staff evidence is returned ephemerally and moderation logs should
remain private.

`/security snapshot compare [index]` lists roles and channels deleted since a
snapshot (with their names, permissions, and overwrites for manual
recreation), changed role permissions, changed channel overwrites, and new
roles holding dangerous permissions. `/security snapshot restore-permissions`
is a dry run unless `confirm:true`; it only rewrites permission bitfields of
roles that still exist, are not managed by an integration, sit below
XenonBot’s highest role, and would not receive permissions XenonBot lacks. It
takes a fresh snapshot first and records an incident. Deleted roles, channels,
messages, and Discord IDs cannot be restored.

Lockdown records a patch journal for each changed overwrite bit on selected
public text, announcement, forum, and media channels. It denies
`SendMessages`, `SendMessagesInThreads`, `CreatePublicThreads`, and
`CreatePrivateThreads` through `@everyone`, role, and non-exempt member
overwrites. The guild owner and Administrator roles bypass channel overwrites;
trusted users and the bot retain only their pre-lockdown effective posting
bits. Known Administrator roles are reported. Lockdown does not cover voice
channels or channels created afterward.

Quarantine uses member-specific denies for `ViewChannel` in text, announcement,
forum, and media channels and `ViewChannel`, `Connect`, and `Speak` in voice/stage channels.
Administrator targets and the guild owner are unsupported; an already
connected voice member may remain connected until disconnected. Newly created
channels are not covered by an existing quarantine.

The configured quarantine role is an optional marker, not enforcement. Xenon
records whether it added the member’s role assignment and removes only a
recorded Xenon-added assignment on release; pre-existing assignments remain.
If Discord accepts the assignment but the ownership record cannot be saved,
manual marker cleanup may be required.

Unlock and unquarantine re-fetch each channel and restore only Xenon-managed
bits that still match Xenon’s last confirmed state. Unrelated overwrite changes
are preserved; edits to the same managed bits become conflicts for manual
recovery. Discord offers no conditional overwrite update, so an external edit
between Xenon’s final read and write can still race. Legacy lockdown snapshots
without a patch journal require manual recovery. Missing Discord objects and
IDs cannot be fully restored.
Discord-native Verification Level, moderator 2FA, explicit-media filtering,
Community/Rules Screening, and Discord Raid Protection (Safety Setup) remain
owner-managed settings. `/security status` and `/security scan` read what the
API exposes (verification level, MFA level, explicit content filter, guild
features) and report `MANUAL ACTION REQUIRED` for anything Xenon cannot verify
or change; Xenon never edits them.

`/security status` reports PROTECTED, DEGRADED (missing log channels, bot
permissions, Message Content, or AutoMod rules), AT RISK (a CRITICAL scan
finding, an open HIGH/CRITICAL incident, or an active RAID/CRITICAL state), or
LOCKDOWN, plus live raid state, native safety, bot hierarchy health, gateway
intents, and manual actions.

### Single instance and recovery

Run exactly one Discord-only runtime per state file. Before connecting, the
runtime takes an OS-owned host mutex (a Windows named pipe or Linux abstract
socket, released automatically if the process dies) and the lease file
`.data/discord-runtime.json.lock`, renewed every 30 seconds.

- A second process on the same host exits immediately with an error.
- A lock left by a crashed process on the same host is replaced on the next
  start.
- A lock written by another host or container is honoured until it has gone
  120 seconds without renewal. After a container is recreated with a new
  hostname, the new container exits until that lease expires; with a
  restart-on-failure policy it then starts normally. A fixed `hostname:` for
  the bot container lets a restarted container take over immediately, but only
  use it when no second bot container (replica or blue/green copy) can run:
  containers sharing a hostname cannot see each other’s host mutex, so the
  older one would run for up to 30 seconds before detecting the takeover.
- If a runtime finds that another runtime has taken over its lease, or cannot
  renew it within the lease, it logs `Runtime instance lock lost` and stops with
  exit code 1 rather than act twice. The state file must not be shared by
  concurrently running bots on different machines: the lease is a safety net,
  not a distributed lock.
- An unreadable lock file blocks startup. Delete it only after confirming no
  bot process is running.

On macOS (development only) the host mutex is unavailable, so the lock falls
back to process-ID checks.

## 4. Configure Xenon guild, channels, and roles

Start the web app and sign in with a Xenon Control Center account. In
**Control → Discord** (`/control/discord`):

1. Configure the primary guild to match `DISCORD_GUILD_ID`.
2. Set the whitelist review channel and any supported announcement or log
   channels to channels in that same guild.
3. Map Xenon roles to the intended Discord roles. Only configured mappings are
   modified; unrelated member roles are preserved.
4. Review OAuth, bot, guild, heartbeat, latency, command, channel, permission,
   and role diagnostics. Resolve `MISSING MANAGE_ROLES`, `ROLE_NOT_FOUND`, and
   `BOT_ROLE_TOO_LOW` before relying on synchronization.

Discord role appearance never grants Xenon capabilities. Staff review actions
resolve the Discord account to its Xenon user and check Xenon permissions on
the server.

## 5. Start Xenon and register commands

From the repository root, start the local dependencies and apply migrations:

```powershell
pnpm infra:up
pnpm db:deploy
```

In separate terminals, run the web and persistent bot processes:

```powershell
pnpm --filter @xenon/web dev
pnpm --filter @xenon/bot dev
```

The web app is at `http://localhost:3200`. The bot is a persistent Node.js
process; it must not be deployed as a Next.js route or serverless function.
The repository requires Node.js `>=24.17.0`; upgrade local Node before live
commissioning. Node `24.12.0` is below the supported minimum.
Run `pnpm discord:diagnose` to print the safe resolved application, guild,
invite, credential-presence, Auth URL, site URL, and callback values. It never
prints either Discord secret.
Register or refresh development guild commands explicitly after configuring
the application and guild:

```powershell
pnpm discord:register
```

The bot also runs the existing Redis-backed job worker. Startup verifies the
configured application, gateway, guild, required channel access, mapped role
hierarchy, and guild command registration. The heartbeat and details appear in
the Xenon health and Discord integration pages. The bot token is never included
in diagnostics.

## 6. Verify OAuth and community membership

1. Open `http://localhost:3200/signin` and choose **Continue with Discord**.
2. Confirm the authorization request uses client ID `1550168431163084921` and
   its decoded `redirect_uri` is exactly
   `http://localhost:3200/api/auth/callback/discord`.
3. After that callback is registered on this same application, authorize the
   Xenon application. Discord may offer to continue in its app;
   that handoff is controlled by Discord.
4. Confirm the browser returns through
   `http://localhost:3200/api/auth/callback/discord` and reaches Xenon portal.
5. In **Portal → Account**, confirm the connected Discord profile and
   community state.
6. If the account is not in the guild, use **Join Discord**. After joining,
   choose **Check again**; this performs a fresh bot-backed lookup without
   signing out.

The states `MEMBER`, `NOT_MEMBER`, `PENDING_SCREENING`, `UNAVAILABLE`, and
`MISCONFIGURED` are distinct. An API outage is never reported as “not a member.”
Membership snapshots are diagnostic/product state and are not Xenon staff
authorization. A pending-screening member is not treated as fully joined for
membership-gated application flows.

## 7. Verify application review and role synchronization

1. Submit a test whitelist application from the website.
2. Confirm the canonical Xenon submission is committed and its review job
   creates a card in the configured review channel.
3. Confirm the card’s **Open in Xenon** action links to the protected Control
   Center review route.
4. As a Xenon staff account with the matching capability, use Approve, Reject,
   Request Changes, or Interview. Discord user identity resolves to a Xenon
   account; Discord role labels alone never authorize the action.
5. Confirm the website immediately shows the canonical new state and event
   history, and the Discord card updates with actor/time and disables obsolete
   actions for terminal states.
6. If approval maps to a Discord role, confirm it is applied. A Discord outage
   does not roll back the Xenon decision; the role job can retry transient
   failures. Missing roles or hierarchy problems are visible in Control Center.

The application service performs the same permission checks and state
transitions for website and Discord actions. Concurrent decisions are guarded
against stale state, and only one transition can commit. DMs are a secondary
notification channel; a closed DM does not undo a website notification or
application decision.

## 8. Operational behavior and secrets

- Keep rotated `AUTH_DISCORD_SECRET` and `DISCORD_BOT_TOKEN` in local `.env` or
  the deployment secret manager. Never use previously shared values.
- Keep `AUTH_SECRET` server-side and stable for the deployment.
- Do not log OAuth tokens, session tokens, bot tokens, or client secrets.
- Signing out ends the Xenon session only; it does not remove Discord roles,
  leave the guild, or unlink the Discord identity.
- Discord OAuth identity is the stable Discord snowflake. Username, global
  name, and avatar are profile data only.
- Database membership and role snapshots can be refreshed by the relevant
  explicit action or background job; ordinary page rendering does not poll
  Discord.
- On `DISCORD_MODE=disabled` development, OAuth and live Discord features are
  unavailable by design. Use the explicit local development sign-in fixture
  only when `AUTH_DEV_LOGIN=true`; it is refused in production.

## 9. Troubleshooting

| Symptom                    | Check                                                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `redirect_uri` error       | Compare the exact registered redirect with the callback shown at `/control/discord`; check scheme, port `3200`, path, and trailing slash. |
| OAuth and bot app mismatch | Set `AUTH_DISCORD_ID` and `DISCORD_APPLICATION_ID` to the same application ID.                                                            |
| Bot offline                | Check `DISCORD_MODE`, the rotated bot token, process logs, and the bot heartbeat. Never paste the token into logs or chat.                |
| Guild unreachable          | Confirm `DISCORD_GUILD_ID`, bot installation to that guild, and that the guild ID matches Xenon Control.                                  |
| Review card not sent       | Check the review channel is in the configured guild and the bot has View Channels, Send Messages, Embed Links, and Read Message History.  |
| Role not synchronized      | Check the mapping is Xenon-owned, the role still exists, Manage Roles is granted, and the bot role is above the mapped role.              |
| Membership unavailable     | Check bot/guild reachability and retry from Portal → Account. An unavailable lookup is not proof the user is absent.                      |
| Preview OAuth fails        | Register that exact preview callback in the Developer Portal and configure the matching public `AUTH_URL` and `NEXT_PUBLIC_SITE_URL`.     |

## Provisioning the server

Xenon can build and maintain the whole server layout from its blueprint. Plan
first, against a development guild. See
[DISCORD_PROVISIONING.md](DISCORD_PROVISIONING.md),
[DISCORD_SERVER_BLUEPRINT.md](DISCORD_SERVER_BLUEPRINT.md),
[DISCORD_PERMISSIONS.md](DISCORD_PERMISSIONS.md),
[DISCORD_ASSETS.md](DISCORD_ASSETS.md) and
[DISCORD_RECOVERY.md](DISCORD_RECOVERY.md). After pulling this change, run
`pnpm db:deploy` and `pnpm discord:register` so `/xenon` and `/room` exist.
