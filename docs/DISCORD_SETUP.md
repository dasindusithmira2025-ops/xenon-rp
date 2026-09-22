# XenonRP Discord integration

This guide configures the existing Xenon website and persistent Discord service
with one official XenonRP Discord Developer Application. Discord is an identity,
community, and notification integration; Xenon’s database and capability
permissions remain authoritative.

## 1. Prepare the Xenon application

In the Discord Developer Portal, select or create the official XenonRP
application. Rotate any Client Secret or Bot Token that has previously been
shared. The Client ID and Bot Token are different values and are never
interchangeable.

Under **OAuth2 → Redirects**, register the exact callback for every environment
that will use OAuth:

| Environment | Redirect URI                                                  |
| ----------- | ------------------------------------------------------------- |
| Development | `http://localhost:3200/api/auth/callback/discord`             |
| Production  | `https://<XENON_PRODUCTION_DOMAIN>/api/auth/callback/discord` |

The URI must match exactly, including scheme, host, port, path, and trailing
slash. Do not register a callback on port 3000 for the local Xenon web server.
For production behind a proxy, set `AUTH_URL` to the externally reachable
origin plus `/api/auth`; do not set it to an internal container address. Keep
`NEXT_PUBLIC_SITE_URL` on the same public origin. Preview deployments need their
own explicitly registered callback before Discord login can be used there.

Xenon player login requests only the `identify` scope. Bot installation scopes
are configured separately below; do not add `email`, `guilds`, `bot`, or
`applications.commands` to the player login flow.

## 2. Configure local environment

Copy `.env.example` to `.env`, generate a new `AUTH_SECRET`, and leave Discord
disabled until the rotated values are ready. Do not commit `.env`, paste secrets
into source files, or put secrets in support messages.

```dotenv
DISCORD_MODE=enabled
AUTH_DISCORD_ID=<Xenon application ID>
AUTH_DISCORD_SECRET=<rotated OAuth client secret>
DISCORD_APPLICATION_ID=<same Xenon application ID>
DISCORD_BOT_TOKEN=<rotated bot token>
DISCORD_GUILD_ID=<Xenon guild ID>
AUTH_URL=http://localhost:3200/api/auth
NEXT_PUBLIC_SITE_URL=http://localhost:3200
```

The application ID in `AUTH_DISCORD_ID` and `DISCORD_APPLICATION_ID` must be
identical. The web process receives the OAuth client secret but not the bot
token; the bot process receives the bot token but not the OAuth client secret.
Neither process stores Discord OAuth access or refresh tokens. `DISCORD_MODE`
must be explicitly enabled for real integration; disabled local mode never
pretends Discord is connected. Production refuses to start with Discord
disabled or with required credentials missing.

The local infrastructure ports are PostgreSQL `5442` and Redis `6389`; preserve
the values already present in `.env.example` unless you intentionally run the
services elsewhere.

## 3. Create and install the bot

In the Developer Portal, open **Bot**, create/configure the bot user, and use
the rotated token in `DISCORD_BOT_TOKEN`. Under **Installation**, enable guild
installation and the `bot` and `applications.commands` scopes.

The implemented bot needs these guild permissions:

- View Channels
- Send Messages
- Embed Links
- Read Message History
- Manage Roles, when Xenon role mappings are enabled

Do not grant Administrator. Xenon uses the `Guilds` Gateway intent only. It
does not enable Message Content, Guild Presences, or the privileged Guild
Members intent: membership checks use a targeted server-side REST lookup for a
known Discord user ID. Install the bot to the Xenon guild and move the Xenon bot
role above every Discord role that Xenon is configured to manage. Discord
cannot grant or remove roles at or above the bot’s highest role.

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
2. Authorize the Xenon application. Discord may offer to continue in its app;
   that handoff is controlled by Discord.
3. Confirm the browser returns through
   `http://localhost:3200/api/auth/callback/discord` and reaches Xenon portal.
4. In **Portal → Account**, confirm the connected Discord profile and
   community state.
5. If the account is not in the guild, use **Join Discord**. After joining,
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
