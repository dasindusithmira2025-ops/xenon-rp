# Discord server blueprint

The XenonRP Discord server is described as code in
`packages/discord/src/provisioning/blueprint.ts` and versioned as
`discord-blueprint-v1`. Xenon plans, applies, validates and repairs the server
from that description. See [DISCORD_PROVISIONING.md](DISCORD_PROVISIONING.md)
for how it is run.

## Logical keys

Every managed resource has a stable logical key. The key is configuration
identity; the Discord snowflake is a runtime mapping stored in
`discord_managed_resources`.

| Prefix       | Example                                            |
| ------------ | -------------------------------------------------- |
| `role.`      | `role.whitelisted`, `role.staff.moderator`         |
| `category.`  | `category.staff`, `category.dept.lspd`             |
| `channel.`   | `channel.city-status`, `channel.dept.lspd.general` |
| `voice.`     | `voice.create-room`, `voice.dept.lspd.operations`  |
| `panel.`     | `panel.city-status`, `panel.dept.lspd.recruitment` |
| `emoji.`     | `emoji.xenon_online`                               |
| `automod.`   | `automod.invites`                                  |
| `space.org.` | `space.org.vagos` (organisation space descriptor)  |

Never rename a key: a renamed key is a new resource to the planner.

## Layout

One emoji per category heading at most; channel names are plain lowercase.

| Category            | Channels                                                                                                                          | Policy                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 🧭 Start Here       | welcome, rules, how-to-join, city-status (bot only), faq*, choose-roles                                                           | `PUBLIC_READ_ONLY`           |
| 📰 City News        | announcements, patch-notes, events (announcement channels with Community)                                                         | `PUBLIC_READ_ONLY`           |
| 💬 Community        | general, introductions*, media, clips, screenshots*, suggestions (forum), community-help (forum), off-topic*                      | `PUBLIC_CHAT`                |
| 🏙️ City Information | departments (when published departments exist), city-guide*, business-directory*, laws*, commands*, `<dept>-information`          | `PUBLIC_READ_ONLY`           |
| 📝 Applications     | applications, whitelist-info*, recruitment, `<dept>-recruitment`                                                                  | `PUBLIC_READ_ONLY`           |
| 🔊 Voice            | General, Chill, Gaming, ➕ Create Room, AFK                                                                                       | `PUBLIC_CHAT`                |
| 🛡️ Staff HQ         | staff-announcements, staff-chat, whitelist-review, application-review*, mod-alerts*, staff-resources, Staff Lounge, Staff Meeting | `STAFF_ONLY`                 |
| ⚙️ Xenon Ops        | bot-logs                                                                                                                          | `MANAGEMENT_ONLY`            |
| `<Department>`      | announcements, general, resources, training*, command, Briefing Room, Operations                                                  | `DEPARTMENT_MEMBER:<slug>`   |
| `<Organisation>`    | general, operations, media, Voice                                                                                                 | `ORGANIZATION_PRIVATE:<key>` |

`*` = off by default. Toggle features in **Control → Discord → Server setup →
Blueprint & spaces**; they are stored in the `discord.blueprint.features`
setting. A category with no enabled channels is not created. Fewer busy
channels beat many dead ones.

Integration channels are written back to Xenon automatically after apply:
`#whitelist-review` → review cards, `#announcements` → published news,
`#bot-logs` → the log channel.

## Roles

Top to bottom: Management, Head Administrator, Administrator, Moderator, Trial
Moderator, Whitelist Team, Support Team, Event Team, department roles,
organisation roles, Content Creator, Whitelisted, Citizen, notification roles,
language roles (off by default).

- Staff colours are chrome and muted greens. Xenon green (`#2AFD23`) is used
  once, on **Whitelisted**. Notification roles have no colour.
- Staff roles carry moderation permissions (timeout, manage messages, kick; ban
  for senior staff). No role is ever given Administrator, Manage Server, Manage
  Roles or Manage Channels by the blueprint.
- Roles that mirror a Xenon role are mapped automatically after apply
  (`Management`→`owner`, `Administrator`→`administrator`,
  `Moderator`→`moderator`, `Whitelist Team`→`reviewer`, `Support Team`→`support`,
  `Citizen`→`member`, department member → `Department.roleKey`). An existing
  operator mapping is never overwritten. **Whitelisted** follows whitelist
  state (`APPROVED`) through the existing role sync.
- A Discord role never grants Xenon permissions. Xenon RBAC stays canonical.

## Panels

Persistent messages Xenon edits in place, never re-posts: welcome, rules
(version and last-updated from the published rulebook, zero-tolerance titles,
link to the full rulebook), how-to-join (six steps), city-status (live),
choose-roles (toggle buttons, only zero-permission notification/language
roles), applications (whitelist state and open templates), departments and
recruitment. Links come from `NEXT_PUBLIC_SITE_URL`; in production a localhost
URL is reported and link buttons are omitted.

## Departments

Departments are not hardcoded. Each `Department` row may carry a
`discordSpace` configuration (`enabled`, `private`, `command`, `voice`,
`training`, `publicInfo`, `recruitment`, `commandRoleKey`). Enabled spaces
expand into member and command roles, a private category, and optional public
channels. Configure it in **Server setup → Blueprint & spaces**; nothing
changes in Discord until a plan is applied.

## Organisations and businesses

Not created at bootstrap. Staff add a space (key, name, kind) for an approved
organisation; it is recorded as a `space.org.<key>` registry row and planned
like any other resource. Private membership (the default) names the role
`Private Space XXXX` so the member list cannot leak who belongs to what, and
management visibility is per space. Archiving switches the category to the
`ARCHIVED` policy (management read-only), renames it `🗄️ Archived · …`, drops
the member role from the blueprint and deletes nothing.

## Changing the blueprint

1. Edit `blueprint.ts` (or `policies.ts` for access semantics).
2. Bump `BLUEPRINT_VERSION` in `types.ts` for structural changes.
3. `pnpm --filter @xenon/discord test` — the blueprint and permission suites
   must pass.
4. Plan against the development server; the changed resources show as
   `UPDATE` because their configuration hash moved.
