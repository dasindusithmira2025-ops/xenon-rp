# Permissions

Authorization is **capability-based**. Code asks "may this actor approve an
application", never "is this actor an admin".

```ts
requirePermission(actor, 'applications.approve');
```

Role names change. Community structures get reorganised. Capabilities are stable,
and a check written against one keeps meaning the same thing after a staff
restructure.

## Where authority comes from

```
User → UserRole → Role → RolePermission → Permission
```

`resolveActor()` walks that path once per request and produces an `Actor`
carrying a resolved `ReadonlySet<PermissionKey>`. Three things happen there that
are easy to get wrong if scattered:

- **Expired role assignments are skipped.** `UserRole.expiresAt` supports trials
  and temporary elevation with no cron job to forget.
- **Suspended and banned accounts keep their role rows but exercise none of
  them.** The sanction is meant to be reversible, so the grants are not deleted.
- **Unknown capability strings are ignored.** A capability removed from the
  catalogue can still have a stale database row; trusting a key the code no
  longer understands is worse than dropping it.

### Discord roles grant nothing

`DiscordAccount.guildRoleIds` is recorded for diagnostics only. Nothing reads it
to make a decision. A staff member who grants themselves a Discord role gains no
capability in XenonRP, and a Discord outage does not lock staff out.

The flow is the other way around: XenonRP decides, then pushes roles to Discord
via `DiscordRoleMapping`.

## The catalogue

Defined once in `packages/core/src/permissions.ts`. The seed writes rows from it,
the `/control` permission matrix renders from it, and `PermissionKey` is derived
from it — so a typo in a capability string is a **compile error**, not a check
that silently never passes.

| Category     | Capabilities                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------- |
| Applications | `view` `review` `assign` `approve` `reject` `request_changes` `interview` `manage_templates` |
| Players      | `players.view` `players.manage` `players.whitelist` `players.ban`                            |
| Support      | `tickets.view` `tickets.reply` `tickets.manage`                                              |
| Reports      | `reports.view` `reports.manage` · **`reports.staff.view` `reports.staff.manage`**            |
| Appeals      | `appeals.view` `appeals.manage`                                                              |
| Content      | `content.view` `content.edit` `content.publish`                                              |
| Rules        | `rules.edit` `rules.publish`                                                                 |
| Departments  | `departments.view` `departments.manage`                                                      |
| Staff        | `staff.view` `staff.manage`                                                                  |
| Integrations | `discord.manage` `fivem.manage`                                                              |
| System       | `audit.view` `system.manage`                                                                 |

**Staff reports are separated on purpose.** A report accusing a staff member must
not be readable by every staff member — that set includes the person being
reported. `reports.staff.*` is withheld from the Moderator preset, and a test
asserts it stays that way.

## Default roles

Seeded by `pnpm db:seed`, then fully editable in `/control`.

| Role                 | Priority | Holds                                       |
| -------------------- | -------- | ------------------------------------------- |
| Owner                | 1000     | Everything, including future capabilities   |
| Administrator        | 900      | Everything except `system.manage`           |
| Moderator            | 700      | Players, support, general reports           |
| Application Reviewer | 600      | Application decisions; no player moderation |
| Support              | 500      | Tickets; read-only on players               |
| Content Editor       | 400      | Content drafts; cannot publish              |
| Member               | 0        | Nothing. Every signed-in account.           |

Owner's `'*'` is expanded to concrete grants at seed time rather than stored as a
wildcard, so the permission matrix shows its real grants instead of a special
case the UI would have to know about. The seed is idempotent and runs on deploy,
which is what keeps Owner current as the catalogue grows.

The seed uses `createMany({ skipDuplicates: true })` rather than delete-then-recreate,
so it adds capabilities a preset has gained without removing one a staff member
deliberately granted by hand.

## Using it

```ts
// Throw if missing. Preferred: a forgotten `if` is invisible, a forgotten
// `requirePermission` is not.
requirePermission(actor, 'applications.approve');

// Either of two capabilities.
requireAnyPermission(actor, ['reports.view', 'reports.staff.view']);

// "My own record, or staff acting on anyone's."
requireOwnerOrPermission(actor, ticket.authorId, 'tickets.view');

// Only for rendering decisions — never as the sole gate.
if (can(actor, 'players.ban')) {
  /* show the button */
}
```

`ForbiddenError` vs `UnauthenticatedError` is a real distinction: one shows
access-denied, the other prompts a sign-in. Collapsing them sends signed-out
users to a dead end.

### Two actors that are not users

`systemActor` — expiry sweeps, retries, sync jobs. **Holds no capabilities.**
System operations call service functions that do not require one, so a bug in a
worker cannot quietly escalate into an approval.

`anonymousActor()` — a request with no session. Fails with
`UnauthenticatedError` rather than `ForbiddenError`.

## Rules for new code

1. **Every mutation checks server-side.** Hiding a link is not access control,
   and neither is a client-side `if`.
2. **Check in the service, not the route.** The same operation is reachable from
   the web, from Discord and from a job. One check at the domain boundary covers
   all three; three checks at three transports will eventually be two.
3. **Never branch on a role key.** `actor.roleKeys` exists for display. If you
   need a new distinction, add a capability.
4. **Add capabilities to the catalogue, never inline.** `PermissionKey` is
   derived from it, so anything else will not compile.
