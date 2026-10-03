# Discord provisioning

One engine, three surfaces: `/xenon setup …` in Discord, **Control → Discord →
Server setup** (`/control/discord/setup`), and `pnpm discord:setup:*`. All of
them create a row in `discord_provision_runs` and execute it through
`apps/bot/src/discord/provisioning/runner.ts`. The web tier never talks to
Discord; it queues a `discord.setup.run` job for the bot.

## Modes

| Mode       | Mutates | What it does                                                                   |
| ---------- | ------- | ------------------------------------------------------------------------------ |
| `PLAN`     | no      | Snapshot the guild, build the desired state, diff, audit permissions.          |
| `STATUS`   | no      | Same analysis, framed as health and drift.                                     |
| `VALIDATE` | no      | Fails (`VALIDATION_FAILED`) if any critical permission test fails.             |
| `APPLY`    | yes     | Execute `CREATE`, `UPDATE`, `MOVE`, `PERMISSION_CHANGE` from an approved plan. |
| `REPAIR`   | yes     | Restore `DRIFT` on managed resources (strict fields; soft on request).         |
| `CLEANUP`  | deletes | Remove resources created by one failed run. Destructive capability only.       |

## Authorization

- `system.discord.bootstrap` — plan, apply, repair, validate, configure spaces.
- `system.discord.bootstrap.destructive` — cleanup.
- Both are Owner-only by default. In Discord, the server owner is also allowed
  to run `/xenon setup`. A Discord Administrator role alone is not enough.
- Every mutation needs the typed phrase `PROVISION XENON` (cleanup:
  `DELETE XENON RESOURCES`) and the id of a successful plan less than 30
  minutes old. The run fails if the fresh plan contains any change that was not
  in the approved plan.
- A guild with substantial unmanaged structure (`ESTABLISHED`) is plan-only
  until the operator also acknowledges it.

## Diff classification

`CREATE`, `UPDATE`, `MOVE`, `PERMISSION_CHANGE`, `UNCHANGED`, `DRIFT`,
`CONFLICT`, `MANUAL_REVIEW`, `CAPACITY_BLOCKED`. Nothing is ever `DELETE` in a
plan.

- **Conflict**: an unmanaged resource already has the name. Resolve it per
  item: **Adopt** (Xenon manages it, history kept), **Keep unmanaged**,
  **Create alternative** (`rules-xenon`, `Moderator · Xenon`), or **Manual**.
  Children of an unresolved category wait.
- **Drift vs update**: each resource stores the hash of the strict and soft
  configuration it was last given. A difference with an unchanged hash is an
  operator's edit (`DRIFT`); a changed hash is a blueprint change (`UPDATE`).
- **Strict** fields: permissions, overwrites, parent category, channel kind,
  role permissions and mentionability. **Soft**: names, colours, topics,
  slowmode, order. Apply never overwrites a soft customisation; repair does so
  only with _include soft_.

## First run on a new server

1. Invite the bot. Temporarily give it the permissions the plan lists under
   `MISSING_BOOTSTRAP_PERMISSION` (typically Manage Roles, Manage Channels,
   Manage Expressions, Manage Server for AutoMod, and the moderation
   permissions the staff roles carry — Discord only lets a bot grant what it
   holds). Temporary Administrator also works.
2. Move the Xenon role to the top of the role list.
3. Register commands: `pnpm discord:register`.
4. `/xenon setup plan` (or **Generate plan**). Resolve every conflict.
5. **Apply** / `/xenon setup apply`. Progress shows per phase with real counts.
6. Health validation runs on the live server. `VALIDATION_FAILED` means a
   restricted area is visible to someone it must not be — fix before going on.
7. Follow the **Onboarding** tab (manual Discord steps).
8. Remove the bootstrap permissions. Runtime needs View Channels, Send
   Messages, Embed Links, Read Message History, Manage Roles. Temporary voice
   rooms get Manage Channels / Move Members through an overwrite on the Voice
   category only.

Always rehearse against a development guild (`DISCORD_GUILD_ID`) first.

## Resuming and restarts

Each success is written to the registry immediately. If a run fails midway,
generate a new plan and apply again: finished work is `UNCHANGED`, the rest is
still `CREATE`. Runs left `RUNNING` by a crash are marked failed on bot start.
Five consecutive Discord failures abort the run. Operations are paced (350 ms)
on top of discord.js rate-limit handling.

## Enforcement

`discord.provisioning.enforcement`: `OBSERVE` (default, report), `REPAIR`
(repair on request), `ENFORCE` (the bot's 30-minute drift sweep restores
critical integration resources: the review channel, city-status channel and
panel, mapped roles and Whitelisted). Drift is posted to `#bot-logs` only when it
changes.

## CLI

```powershell
pnpm discord:setup:plan
pnpm discord:setup:apply -- --plan <runId> --confirm "PROVISION XENON" [--ack-established]
pnpm discord:setup:status
pnpm discord:setup:validate
pnpm discord:setup:repair -- --plan <runId> --confirm "PROVISION XENON" [--soft]
pnpm discord:setup:cleanup -- --run <failedRunId> --confirm "DELETE XENON RESOURCES" [--force]
```

`apply` without `--plan` prints a fresh plan and the exact command to approve it.

## Audit

Every mutation writes an audit row (`DISCORD_ROLE_CREATED`,
`DISCORD_CHANNEL_CREATED`, `DISCORD_PERMISSION_UPDATED`,
`DISCORD_EMOJI_UPLOADED`, `DISCORD_PANEL_CREATED`, `DISCORD_RESOURCE_ADOPTED`,
`DISCORD_SETUP_APPLIED`, `DISCORD_DRIFT_REPAIRED`, `DISCORD_RESOURCE_DELETED`,
…) with source `WEB`, `DISCORD`, `CLI` or `SYSTEM`.

## Live features

- **City status**: the panel is edited after each status poll when players,
  state or queue change, and at least every ten minutes. Never a fake number.
- **Presence**: rotates every five minutes through real lines, such as
  `City Online • 84/128`, `Applications Open` and the site host. Off via the
  `livePresence` feature.
- **Temporary voice**: join ➕ Create Room, then use `/room` (`rename`, `limit`,
  `lock`, `unlock`, `permit`, `remove`, `transfer`). Rate limited, 25 rooms
  max, state in Redis, empty rooms deleted and swept on start. Needs the
  non-privileged `GuildVoiceStates` intent.
- **AutoMod** (off by default): mention spam, invite links, Discord's spam
  preset. Block and alert to `#mod-alerts`; never ban. Controlled with
  `/xenon automod` (`enable`, `disable`, `status`); disable turns rules off
  without deleting them.

## Text-first Xenon panels

Panels use Discord embeds and native components only; no banner, background,
GIF, or attached image is required. Provisioning records each panel by stable
logical key (for example `panel.welcome`, `panel.support`,
`panel.city-status`, and `panel.choose-roles`) with its channel and message
IDs. Apply and refresh edit the registered message in place. A missing message
is reported and can be restored with repair instead of creating a duplicate
on every bot restart.

Use `/xenon panel setup` to review missing panels, `/xenon panel refresh` to
edit existing messages, `/xenon panel status` to check their references and
rendered versions, and `/xenon panel repair` to plan restoration. These
commands use Xenon `system.discord.bootstrap` authorization (with the existing
guild-owner setup exception); Discord role names alone do not grant access.

The reusable panel set includes welcome, support, applications, rules, city
status, self roles, recruitment, and whitelist review. Support and application
menus link into Xenon's canonical portal flows. Application choices are
limited to currently open configured templates. The city-status panel uses
real snapshots and displays an unavailable state when live values are absent.
Announcement authoring is in **Control → News**: choose content type,
website/Discord destinations, managed target channel, optional safe notification
role, and an optional schedule. Discord delivery is queued and references the
existing announcement message for retry-safe updates.

Welcome behavior is configurable in **Control → Discord**. Join events are
off until enabled. If a public or DM join welcome or initial role is enabled,
the bot conditionally requests the `GuildMembers` gateway intent. Also enable
**Server Members Intent** for the same bot application under **Discord
Developer Portal → Bot → Privileged Gateway Intents**. Message Content Intent
is not used or enabled. Xenon account ID and whitelist state appear only in an
opted-in private DM for an already linked account; public welcomes contain no
private account data.

Discord support notifications are a view into Xenon's canonical ticket data.
Category selection opens the matching portal workflow; ticket creation and
replies remain stored in Xenon. A ticket DM card may link to the portal and,
when enabled, close the canonical ticket through the shared permission-checked
service. It does not create a second ticket transcript in Discord.

## Not automated

Discord onboarding, Community enablement and the AFK channel are listed as
manual steps with exact instructions. Server icon, banner and splash are not
changed by Xenon. Scheduled events and creator live notifications are not part
of this version.
