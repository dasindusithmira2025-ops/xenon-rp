# Discord setup

Xenon uses Discord for three separate things, and they fail independently:

| Purpose          | Needs                                       | If it breaks                              |
| ---------------- | ------------------------------------------- | ----------------------------------------- |
| Sign-in (OAuth2) | Client ID + secret + redirect URI           | Nobody can sign in                        |
| Bot (gateway)    | Bot token + guild ID + the bot in the guild | Roles stop syncing, review cards go stale |
| Role mirroring   | Role mappings in the database               | Coloured names drift from reality         |

Only the first two are environment variables. **Role IDs, channel IDs and the
invite link are not** — they live in the database and are edited from
`/control → Discord`, so changing a mapping never requires a redeploy.

---

## 1. Create the application

<https://discord.com/developers/applications> → **New Application**.

From **General Information**, copy the **Application ID**. It is the same value
as the OAuth2 client ID:

```dotenv
AUTH_DISCORD_ID=<application id>
DISCORD_APPLICATION_ID=<application id>
```

## 2. OAuth2

**OAuth2 → Client Secret → Reset Secret**, then:

```dotenv
AUTH_DISCORD_SECRET=<client secret>
```

Under **Redirects**, add one entry per environment. Discord matches these
exactly — no wildcards, no trailing slash:

```
http://localhost:3200/api/auth/callback/discord
https://your-domain/api/auth/callback/discord
```

Scopes are requested by the app (`identify`, `email`, `guilds`) and do not need
configuring here.

## 3. Bot

**Bot → Reset Token**:

```dotenv
DISCORD_BOT_TOKEN=<bot token>
```

Enable **Server Members Intent**. The bot asks for `Guilds` and `GuildMembers`
and nothing else; it does not read message content, and it will fail to start
if you enable Message Content Intent without the app requesting it.

Invite the bot with `bot` and `applications.commands`, and these permissions:

| Permission           | Why                                     |
| -------------------- | --------------------------------------- |
| Manage Roles         | Mirroring Xenon roles onto members      |
| Send Messages        | Review cards and announcements          |
| Embed Links          | Every message the bot sends is an embed |
| Read Message History | Editing a review card it posted earlier |

**Do not give it Administrator.** The failure mode that costs you a weekend is
a bot with Administrator quietly stripping roles because a mapping was wrong;
a bot with only Manage Roles cannot reach roles above its own, and Xenon
reports that as a fixable setup problem rather than a stream of 403s.

Then:

```dotenv
DISCORD_GUILD_ID=<right-click your server → Copy Server ID>
```

Server ID requires **Developer Mode** (User Settings → Advanced).

## 4. Role hierarchy

Drag the bot's own role **above** every role it is expected to manage.

Discord refuses role changes at or above the bot's highest role. Xenon checks
this before attempting a change and records it on the mapping, so
`/control → Discord` will show the mapping as **hierarchy blocked** with the
reason rather than silently doing nothing.

## 5. Register slash commands

Commands are registered per guild, which propagates instantly, unlike global
commands:

```bash
pnpm --filter @xenon/bot register
```

| Command        | Who    | Does                                  |
| -------------- | ------ | ------------------------------------- |
| `/status`      | anyone | Server status, from the last snapshot |
| `/profile`     | anyone | A player's Xenon profile              |
| `/link`        | anyone | Redeem a FiveM link code              |
| `/application` | anyone | The state of an application           |
| `/queue`       | staff  | The review queue                      |
| `/review`      | staff  | Open one application's review card    |
| `/player`      | staff  | Player lookup                         |

Staff commands check capabilities against the database, not against Discord
roles — a Discord admin who is not staff in Xenon gets refused.

## 6. Channels and mappings

Everything else is configured in the product, at `/control → Discord`:

- **Server ID and name** — must match `DISCORD_GUILD_ID`
- **Review channel** — receives application review cards
- **Announcements** — receives published news
- **Log channel** — receives audit-relevant events
- **Role mappings** — Xenon role ↔ Discord role ID, with a per-mapping
  _Push to Discord_ switch

A mapping with _Push to Discord_ off is observed but never written, which is
the safe way to introduce a mapping you are not yet sure about.

Unmapped Discord roles are never touched. Colour roles, pingable event roles and
anything else your community uses survive synchronisation untouched, because
the diff is computed against the mapped set rather than against everything a
member holds.

---

## How syncing actually works

Xenon decides who holds which role. Discord is told afterwards.

1. A role changes in Postgres — an approval, a manual grant, an expiry sweep.
2. The change commits, with its audit entry.
3. A `discord.role.sync` job is enqueued.
4. The worker reads the desired set from the database, reads the member's
   current roles, and applies the difference.

Discord is never an input. If the guild is unreachable the job retries (eight
attempts, five-second backoff); the role is already correct in Xenon and the
player already has the access it confers.

A member who has left the guild is reported as `memberMissing` and their Xenon
roles are left alone. Leaving your Discord does not revoke anything.

---

## Troubleshooting

| Symptom                                | Cause                                                           |
| -------------------------------------- | --------------------------------------------------------------- |
| `Used disallowed intents` on bot start | Server Members Intent is off                                    |
| Sign-in returns `invalid_redirect_uri` | Redirect URI mismatch — check protocol, port and trailing slash |
| Roles never appear in Discord          | No mapping, or _Push to Discord_ is off                         |
| Mapping shows **hierarchy blocked**    | Bot's role sits below the target role                           |
| Review cards never post                | No review channel set, or the bot cannot see it                 |
| Slash commands missing                 | `pnpm --filter @xenon/bot register` not run for that guild      |
| Bot healthy, nothing syncing           | Redis down — jobs cannot be enqueued; check `/control → Health` |

The bot writes a heartbeat that `/control → Health` reads. `bot=HEALTHY,
worker=HEALTHY` means the gateway is connected and the queue is being consumed;
either one missing narrows the problem immediately.
