# Security live validation (disposable test guild only)

The automated suite runs against mocked Discord objects. This checklist is the
only way to prove behavior against the real Discord API. Run it **only** in a
separate, disposable test guild. Never point `DISCORD_GUILD_ID` at the XenonRP
production server while following it, and never run steps 7–10 anywhere else.

Record a pass/fail for every numbered check. Stop at the first unexpected
mutation and take the rollback steps in §15.

## 0. Isolation

- Create a **separate Discord application** for testing (Developer Portal →
  New Application → Bot). Do not reuse the production token: the test bot then
  can never act in the production guild.
- Use a **separate working copy** of the repository (for example
  `C:\xenon-security-test`). Runtime state lives in that copy's
  `.data/discord-runtime.json`, and the single-instance lock is per state file,
  so a separate copy keeps test state and locks away from production.
- Prepare three Discord accounts: **Owner** (creates the test guild),
  **Mod** (staff), and **Alt1/Alt2** (ordinary members, raid/spam actors).
  Alt accounts must be real users; bots cannot join guilds as members.

## 1. Bot permissions and role hierarchy

1. Invite the test bot with permission integer `1477740424374` (see
   [DISCORD_PERMISSIONS.md](DISCORD_PERMISSIONS.md)) and scopes
   `bot applications.commands`. Do **not** grant Administrator.
2. Server Settings → Roles: drag the bot's role **above** `Staff`, `Mods`,
   `Members`, and any role it must contain or remove; keep it **below** an
   `Owner`-style role so you can also verify the hierarchy refusal.
3. Create disposable roles: `Members` (default chat), `Mods` (Manage Messages,
   Moderate Members, Kick, Ban), `Rogue Admin` (Manage Channels, Manage Roles;
   placed below the bot), and `Above Bot` (placed above the bot).
4. Create disposable channels: `#general`, `#chat-2`, `#announcements`,
   `#staff` (private), plus `#delete-me-1..4` for anti-nuke.

## 2. Required privileged intents

Developer Portal → Bot → Privileged Gateway Intents: enable **Server Members**
and **Message Content**. Leave Presence off.

## Test-guild startup

PowerShell, from the test working copy:

```powershell
pnpm install
pnpm --filter @xenon/bot build
$env:NODE_ENV = 'production'
$env:LOG_LEVEL = 'info'
$env:BOT_RUNTIME_MODE = 'discord-only'
$env:DISCORD_MODE = 'enabled'
$env:DISCORD_APPLICATION_ID = '<test application id>'
$env:DISCORD_BOT_TOKEN = '<test bot token>'
$env:DISCORD_GUILD_ID = '<test guild id>'
$env:DISCORD_INVITE_URL = 'https://discord.gg/<test invite>'
pnpm --filter @xenon/bot start
```

POSIX shell equivalent:

```bash
pnpm install && pnpm --filter @xenon/bot build
NODE_ENV=production LOG_LEVEL=info BOT_RUNTIME_MODE=discord-only DISCORD_MODE=enabled \
DISCORD_APPLICATION_ID=<test app id> DISCORD_BOT_TOKEN=<test token> \
DISCORD_GUILD_ID=<test guild id> DISCORD_INVITE_URL=https://discord.gg/<test invite> \
pnpm --filter @xenon/bot start
```

Expected log lines: `Discord connected`, `Guild resolved`, `Discord slash
commands registered`, `Xenon Discord service ready`. No `Message Content is
unavailable` warning (otherwise §2 is incomplete).

## 3. `/security setup`

1. As Owner: `/security setup`. Expect `#security-alerts`, `#security-audit`,
   `#mod-logs`, and `Xenon Quarantine` (no permissions) to be created.
2. Run `/security setup` again. Expect **Created: none** and no duplicate
   channels, roles, or AutoMod rules.
3. `/security trust add user:@Mod level:TRUSTED_STAFF`, then
   `/security trust list`; the first line shows Owner as OWNER.
4. `/security mode status` → mode **OBSERVE** (new installs never start in
   ENFORCE). `/security status` → posture **DEGRADED** with the mode shown.
5. `/security config raid-thresholds warning10s:1 raid10s:2 critical10s:3
warning30s:1 raid30s:2 critical30s:3 recovery_minutes:2 slowmode_seconds:10`
   and `/security config spam messages_per_8s:3 duplicates:2` so tests are
   reproducible with a few accounts.
6. `/security snapshot take`.

## 4. OBSERVE validation (expect detection, no actions, no posts)

1. Alt1 and Alt2 leave and rejoin within 10 s (raid simulation).
2. Alt1 sends 4 identical messages quickly in `#general`.
3. Expect: no slowmode, no quarantine, no deleted messages, no timeouts, no DMs,
   and **no new posts** in `#security-alerts`/`#security-audit`/`#mod-logs`.
4. `/security incident list` shows the raid/spam incidents with
   `OBSERVED: would …` actions.

## 5. ALERT validation (expect posts, still no actions)

1. `/security mode set mode:alert`. `#security-audit` gets the mode-change
   record.
2. Repeat §4 steps 1–2.
3. Expect alert embeds in `#security-alerts` (repeat alerts collapse with a
   suppressed count) and still **no** slowmode, quarantine, deletion, timeout,
   or DM.

## 6. ENFORCE validation

1. `/security mode set mode:enforce` (without confirm): nothing changes; the
   reply lists the protections that would activate.
2. `/security mode set mode:enforce confirm:true`. `/security mode status` →
   ENFORCE; `/security status` → PROTECTED (if no other findings).
3. Alt1 sends 4 identical messages: messages deleted, one case in `#mod-logs`,
   a DM to Alt1; a further burst within 15 s only deletes.

## 7. Controlled anti-raid simulation (ENFORCE)

1. Alt1, Alt2 (and a third account if available) join within 10 s.
2. Expect: incident `Raid detection entered RAID/CRITICAL`, arrivals receive
   member-specific `ViewChannel` denies (verify with View Server As → Alt1),
   `#general`/`#chat-2` get 10 s slowmode, Owner/Mod joining are **not**
   quarantined.
3. Wait `recovery_minutes` (2 min) without joins: slowmode returns to its
   previous value; an INFO `Raid response ended` incident is recorded.
4. Manually change `#chat-2` slowmode during a raid, then let recovery run:
   `#chat-2` keeps your value and the incident lists a conflict.

## 8. Anti-nuke with disposable channels/roles

1. Give Alt2 the `Rogue Admin` role. As Alt2, delete `#delete-me-1..3` within
   30 s.
2. Expect a CRITICAL anti-nuke incident with `Audit correlation: CONFIRMED`,
   `Rogue Admin` removed from Alt2, and (with auto-lockdown on) lockdown
   active. `#security-audit` shows the correlated audit entry.
3. Give Alt2 the `Above Bot` role and repeat with `#delete-me-4` plus new
   disposable channels: expect `PROTECTION_BLOCKED_BY_ROLE_HIERARCHY`, no
   change to Alt2.
4. Owner deletes two disposable channels: no containment (owner exempt).
5. Temporarily remove the bot's View Audit Log, delete three disposable
   channels: alert-only incident with attribution `UNAVAILABLE`, no
   containment. Restore the permission.

## 9. Quarantine and moderation

1. `/security quarantine member:@Alt1 reason:test` → Alt1 cannot see public
   channels (View Server As); staff channels unaffected; `#security-*` not
   modified.
2. `/security unquarantine member:@Alt1 reason:test` → access restored exactly.
3. `/security quarantine` targeting a member with `Above Bot` → refused.
4. `/timeout member:@Alt1 minutes:1 reason:test` works in **every** mode
   (switch to OBSERVE and repeat). Repeat within 15 s → rejected as duplicate.
5. `/ban` Alt2 twice → second is rejected as already banned; `/unban` works;
   `/case`, `/cases`, `/warnings` show persistent IDs.

## 10. Lockdown and permission restoration

1. Note the overwrites of `#general` and `#announcements`.
2. `/security lockdown reason:test` → members cannot send; staff and the bot
   still can; `#security-*` untouched. Run it again → idempotent.
3. While locked, add an unrelated overwrite (e.g. allow Attach Files for
   `Members`) on `#general`.
4. `/security unlock` → original send permissions restored; your unrelated
   edit is preserved. Changing a lockdown-managed bit while locked must be
   reported as a conflict, not overwritten.
5. Switch to OBSERVE while a lockdown is active, then `/security unlock`:
   unlock still works.

## 11. Native AutoMod reconciliation

1. `/security automod sync` → three `XENON | …` rules created.
2. Run again → updated, not duplicated.
3. Create your own rule named `XENON | Mention Spam` manually → reported as a
   conflict and left untouched.
4. `/security automod status` matches Server Settings → AutoMod.

## 12. Restart and persistent state

1. During an active lockdown and raid slowmode, stop the bot (Ctrl+C) and start
   it again.
2. `/security mode status`, `/security status`, `/security incident list`,
   `/cases` show the same state; `/security unlock` still restores; raid
   recovery still completes after restart (in ENFORCE).

## 13. Incident and audit log verification

1. `/security incident view id:<id>` shows severity, rule, actor, evidence,
   correlation, response, and status.
2. `/security incident resolve id:<id> note:verified` → status RESOLVED;
   resolving again reports already resolved.
3. `/security scan` lists findings with descriptions and remediation; large
   reports are split into numbered ephemeral follow-ups with severity counts.
   Native settings that the API cannot change are marked `MANUAL ACTION REQUIRED`.

## 14. Single-instance verification

1. With the bot running, start a second copy from the same working copy in
   another terminal → it exits with `Another Xenon Discord runtime on this host`.
2. Kill the running bot hard (Task Manager / `kill -9`) and start it again →
   it starts (stale lock reclaimed).

## 15. Rollback validation

1. `/security mode set mode:observe` → automatic actions stop immediately;
   existing restrictions remain until released.
2. Release everything: `/security unlock`, `/security unquarantine` for each
   quarantined member, `/security raid-mode off` (releases raid slowmode),
   then `/security raid-mode auto`.
3. Stop the bot, check out the previous commit, rebuild, start: the state file
   loads (new fields are optional) and commands register.
4. Delete the test guild and the test application when finished.

Production rollout after a clean pass: deploy, run `/security setup`, review
`/security scan`, stay in OBSERVE for at least a few days, move to ALERT, and
only then `/security mode set mode:enforce confirm:true`.
