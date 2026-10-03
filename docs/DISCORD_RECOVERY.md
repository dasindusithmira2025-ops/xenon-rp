# Discord recovery

## Something was deleted or changed in Discord

1. `/xenon setup status` (or **Status** in Server setup). Deleted or edited
   managed resources appear as `DRIFT`; permission leaks appear as critical
   diagnostics.
2. `/xenon setup repair`, review, confirm with `PROVISION XENON`. Strict fields
   (permissions, category, existence) are restored; add _include soft_ to also
   restore names and topics.
3. Channels recreated by repair are new channels — Discord history of the
   deleted one is gone. Panels are re-posted.

With enforcement set to `ENFORCE`, the critical integration resources are
restored automatically by the 30-minute sweep.

## An apply failed halfway

Nothing is lost: every success is already in the registry.

- Fix the cause (usually a missing permission or the Xenon role sitting too
  low), generate a new plan and apply again. Only the remainder runs.
- To undo instead: **History → Clean up** on the failed run (destructive
  capability, `DELETE XENON RESOURCES`), or
  `pnpm discord:setup:cleanup -- --run <id> --confirm "DELETE XENON RESOURCES"`.
  Only resources that exact run created are deleted. Channels with member
  messages, and roles (membership cannot be verified without the privileged
  members intent), are kept unless `--force`.

Discord has no transactions; this is cleanup, not rollback.

## The bot restarted during a run

The run is marked `FAILED` ("Interrupted by a restart") on startup. Plan and
apply again.

## "The server changed since the plan was approved"

Someone edited the server between plan and apply. Generate a fresh plan and
review it; Xenon will not apply changes you did not see.

## Validation failed after apply

A restricted area is visible to someone it must not be — usually an
operator-added overwrite or a role given Administrator. The diagnostic names
the channel and persona. Remove the offending overwrite or permission, or run
repair for managed overwrites, then **Validate**.

## Taking a resource out of Xenon's hands

Resolve its conflict as **Keep unmanaged**, or delete its row from
`discord_managed_resources` (it will then show as a conflict on the next plan).
Xenon never deletes unmanaged resources.

## Retiring an organisation

Archive the space in Server setup and apply. Members lose access, sending is
locked, history stays, and management can still read it. Deleting the category
afterwards is a manual staff decision in Discord.
