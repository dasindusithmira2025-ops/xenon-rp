# Discord permissions

The managed guild blueprint uses named policies in
`packages/discord/src/provisioning/policies.ts`. The Discord-only security
controller separately applies quarantine and reversible lockdown overwrites.

## Policies

| Policy                               | @everyone | Grants                                          |
| ------------------------------------ | --------- | ----------------------------------------------- |
| `PUBLIC_READ_ONLY`                   | read      | management moderate                             |
| `BOT_ONLY`                           | read      | — (bot only posts)                              |
| `PUBLIC_CHAT`                        | write     | staff moderate                                  |
| `WHITELISTED_CHAT`                   | hidden    | Whitelisted write, staff moderate               |
| `STAFF_ONLY`                         | hidden    | staff write, management moderate                |
| `STAFF_ANNOUNCE`                     | hidden    | staff read, management moderate                 |
| `MANAGEMENT_ONLY`                    | hidden    | management moderate                             |
| `DEPARTMENT_MEMBER:<slug>`           | hidden    | member write, command moderate, management read |
| `DEPARTMENT_ANNOUNCE:<slug>`         | hidden    | member read, command moderate, management read  |
| `DEPARTMENT_COMMAND:<slug>`          | hidden    | command moderate, management read               |
| `DEPARTMENT_PUBLIC:<slug>`           | read      | command write, management moderate              |
| `ORGANIZATION_PRIVATE[_STAFF]:<key>` | hidden    | organisation write (+ management read)          |
| `ARCHIVED`                           | hidden    | management read                                 |

`read`, `write` and `moderate` map to bits per channel kind (text, forum,
announcement, voice, category). The bot always gets a member overwrite for
View, Send, Embed Links, Read History, Attach Files and External Emoji; on the
Voice category it also gets Manage Channels, Manage Permissions, Move Members
and Connect for temporary rooms.

Policies are set on categories; channels inherit (stay synced) unless they name
their own policy (`#city-status`, `#staff-announcements`, department
announcements and command channels, public department channels). Overwrites
for roles Xenon does not manage are left alone and audited.

## Critical access tests

`effective.ts` reimplements Discord's permission algorithm (base from
@everyone and roles, Administrator bypass, then @everyone, role and member
overwrites) and evaluates representative members — @everyone, Citizen,
Whitelisted, a subscriber holding every self-assignable role, Content Creator,
each staff role, each department member and command, each organisation member,
and the bot — against every managed channel.

Critical failures (a plan will not apply; a finished apply reports
`VALIDATION_FAILED`):

- someone sees a channel outside its visibility (`PERMISSION_LEAK`): e.g.
  @everyone in Staff HQ, Citizen in `#whitelist-review`, a moderator in Xenon
  Ops, another department in a department space, anyone in a private
  organisation;
- a player-facing role (player, department, organisation, notification,
  language) holds moderation or management permissions, or @everyone does;
- a self-assignable role is granted anything on a channel;
- Administrator on any non-management role.

Warnings: staff who cannot see a staff channel, unmanaged roles that can view a
restricted channel, Administrator on management.

The **Permissions** tab in Server setup and `/xenon setup permissions` show who
can view, send and manage each restricted area.

## Hierarchy

Discord only lets the bot manage roles below its highest role. The planner
reports `ROLE_ABOVE_BOT` / `BOT_ROLE_TOO_LOW` and marks those items
`MANUAL_REVIEW`; `MISSING_MANAGE_ROLES` and `MISSING_BOOTSTRAP_PERMISSION`
name exactly what is missing. New roles are ordered directly below the Xenon
role in blueprint order; later reordering by staff is reported, not reverted.

## Self-roles

`#choose-roles` toggles only `role.notify.*` and `role.lang.*` roles that Xenon
manages and that hold zero permissions — checked live on every click, rate
limited to 10 per minute per member.

## Discord-only security controller

The security controller does not use Administrator. Grant only the permissions
for the enabled features:

| Permission                                                                             | Used for                                                                                                                                                   |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| View Channels, Send Messages, Embed Links                                              | Inspect configured security channels and post incident/case embeds                                                                                         |
| View Audit Log                                                                         | Correlate audit-event actions with their actor and target                                                                                                  |
| Manage Channels                                                                        | Create security channels during setup; apply and restore raid slowmode                                                                                     |
| Manage Roles                                                                           | Edit lockdown/quarantine overwrites, contain dangerous roles, optionally apply the marker role, and run confirmed `/security snapshot restore-permissions` |
| View Channels, Connect, Speak                                                          | Permission authority for the corresponding quarantine deny bits in each target channel                                                                     |
| Send Messages, Send Messages In Threads, Create Public Threads, Create Private Threads | Permission authority for lockdown deny bits in each selected channel                                                                                       |
| Manage Messages                                                                        | Delete spam and run `/purge`                                                                                                                               |
| Moderate Members                                                                       | Timeout/untimeout actions                                                                                                                                  |
| Kick Members                                                                           | `/kick`                                                                                                                                                    |
| Ban Members                                                                            | `/ban`, `/unban`, and `/softban`                                                                                                                           |
| Manage Server                                                                          | Create/reconcile Xenon-owned Discord AutoMod rules                                                                                                         |
| Read Message History                                                                   | Existing ticket transcripts                                                                                                                                |

Discord’s [edit-overwrite API](https://docs.discord.com/developers/resources/channel#edit-channel-permissions) requires `Manage Roles` to edit channel permission overwrites.
Containment also requires the bot to have the permission bits it will deny in
each target channel; Xenon reports missing per-channel authority as partial
containment rather than success.

Quarantine enforcement uses member-specific overwrites, not a quarantine-role
deny. Xenon denies `ViewChannel` in text, announcement, forum, and media
channels and denies `ViewChannel`, `Connect`, and `Speak` in voice/stage
channels. This remains effective when another ordinary role grants access.
`Xenon Quarantine` is optional; its existence and hierarchy do not affect
effective restrictions. Manage Roles is still required to edit channel overwrites.
On release, Xenon removes only a marker assignment it recorded adding;
pre-existing assignments remain. Guild owners and Administrator members cannot
be quarantined. A member already connected to voice may remain connected until
disconnected, and channels created after quarantine are not covered.

Older Xenon versions may have written channel overwrites for the marker role.
Recover legacy quarantines, then inspect and remove stale role-specific channel
overwrites manually; `/security setup` does not rewrite them.

Lockdown modifies the `@everyone` overwrite plus role/member overwrites that
allow `SendMessages`, `SendMessagesInThreads`, `CreatePublicThreads`, or
`CreatePrivateThreads`. It freezes trusted-user and bot exceptions from their
pre-lockdown effective posting access. Administrator roles and the guild owner
bypass channel overwrites; Xenon reports known Administrator-role bypasses.
Lockdown covers selected public text, announcement, forum, and media channels,
not voice/stage channels or channels created afterward.

The bot does not need Manage Webhooks: webhook audit events are observed but
webhooks are never changed. The Discord-only runtime requests
`GuildModeration` to receive anti-nuke audit events, `GuildMessages` for message
events, and privileged `MessageContent` for ticket transcripts and enabled
custom spam/link scanning. If Discord rejects Message Content, those local
features degrade while native AutoMod remains available. `GuildMembers`
supplies join/leave security signals. Neither presence intent nor Administrator
is used.

`/security scan` reports missing global bot permissions and role risks without
editing permissions. Large reports are split into numbered ephemeral messages
with severity counts, complete finding details, and remediation. Xenon verifies
target-channel access and re-fetches overwrites before and after each patch;
failures are reported as partial containment, not success.

`/security snapshot restore-permissions confirm:true` edits only role
permission bitfields of existing, non-managed roles below XenonBot’s highest
role, and skips any role whose snapshot permissions include a bit XenonBot does
not itself hold. Raid slowmode is restored only where the channel still has the
value Xenon applied.

Member-targeting moderation commands require the invoking moderator’s highest
role to strictly outrank the target, except for the guild owner. `/unban` has
no in-guild member to compare. The bot’s own hierarchy is checked separately
for bot-managed role/member actions. Dangerous-role containment is limited by
XenonBot’s highest role.

Unlock and unquarantine restore only Xenon-managed permission bits that still
match the last confirmed Xenon state. Changes to unrelated bits are preserved;
conflicts on managed bits remain recorded for manual recovery. Discord does not
provide conditional overwrite updates, so an external edit between Xenon’s
final read and write can still race. Legacy lockdown snapshots without a patch
journal require manual recovery. Deleted Discord objects cannot be recreated.
