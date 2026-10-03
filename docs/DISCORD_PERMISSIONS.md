# Discord permissions

Channel access comes from named policies in
`packages/discord/src/provisioning/policies.ts`. No overwrite is written by
hand anywhere else.

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
