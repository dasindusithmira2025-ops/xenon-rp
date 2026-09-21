'use client';

import { ShieldCheck, ShieldX } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Badge, Button, ConfirmDialog, Field, Panel, Select, Textarea, useToast } from '@xenon/ui';

import {
  assignRoleAction,
  grantWhitelistAction,
  removeRoleAction,
  revokeWhitelistAction,
  setUserStatusAction,
} from '~/app/(control)/control/actions';

/**
 * Moderation actions for one player.
 *
 * Whitelist and account-status changes are confirmed, and a ban asks for the
 * player's identifier to be typed. Banning is the one action here that ends
 * somebody's time in the community immediately - the extra three seconds are
 * worth it, and only for that one.
 *
 * Roles the actor cannot manage are shown and disabled rather than hidden, so
 * a moderator can see the structure without being able to change the parts
 * above them. The service refuses anyway.
 */

export interface PlayerActionsProps {
  readonly userId: string;
  readonly publicId: string;
  readonly whitelistState: string;
  readonly accountStatus: string;
  readonly roles: readonly { id: string; name: string; key: string; priority: number }[];
  readonly assignedRoleIds: readonly string[];
  readonly can: { whitelist: boolean; ban: boolean; staff: boolean };
}

type Pending = 'grant' | 'revoke' | 'ban' | 'unban' | null;

export function PlayerActions({
  userId,
  publicId,
  whitelistState,
  accountStatus,
  roles,
  assignedRoleIds,
  can,
}: PlayerActionsProps): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [reason, setReason] = React.useState('');
  const [dialog, setDialog] = React.useState<Pending>(null);
  const [busy, startTransition] = React.useTransition();

  const assigned = new Set(assignedRoleIds);

  const run = (action: () => Promise<{ ok: boolean; message?: string }>, success: string): void => {
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        toast.success(success);
        setDialog(null);
        setReason('');
        router.refresh();
        return;
      }
      toast.error('That did not go through', result.message ?? 'Try again.');
    });
  };

  return (
    <>
      <Panel tone="raised" pad="lg" edgeLight className="flex flex-col gap-4">
        <p className="x-eyebrow">Actions</p>

        {can.whitelist || can.ban ? (
          <Field
            label="Reason"
            htmlFor="reason"
            hint="Recorded in the audit log and shown to the player where relevant."
          >
            <Textarea
              id="reason"
              value={reason}
              rows={3}
              maxLength={500}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
          </Field>
        ) : null}

        <div className="flex flex-col gap-2">
          {can.whitelist ? (
            whitelistState === 'APPROVED' ? (
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  setDialog('revoke');
                }}
              >
                <ShieldX /> Revoke whitelist
              </Button>
            ) : (
              <Button
                variant="accent"
                disabled={busy}
                onClick={() => {
                  setDialog('grant');
                }}
              >
                <ShieldCheck /> Grant whitelist
              </Button>
            )
          ) : null}

          {can.ban ? (
            accountStatus === 'ACTIVE' ? (
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  setDialog('ban');
                }}
              >
                Ban account
              </Button>
            ) : (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setDialog('unban');
                }}
              >
                Reinstate account
              </Button>
            )
          ) : null}
        </div>
      </Panel>

      {can.staff ? (
        <Panel tone="flat" pad="lg" className="flex flex-col gap-3">
          <p className="x-eyebrow">Roles</p>

          <div className="flex flex-wrap gap-2">
            {roles
              .filter((role) => assigned.has(role.id))
              .map((role) => (
                <button
                  key={role.id}
                  type="button"
                  disabled={busy || role.key === 'member'}
                  onClick={() => {
                    run(() => removeRoleAction(userId, role.id), `Removed ${role.name}`);
                  }}
                  className="group"
                  aria-label={`Remove ${role.name}`}
                >
                  <Badge
                    tone="chrome"
                    className="group-hover:border-danger/50 group-hover:text-danger"
                  >
                    {role.name}
                    {role.key === 'member' ? null : <span aria-hidden> ×</span>}
                  </Badge>
                </button>
              ))}
          </div>

          <Select
            value=""
            aria-label="Add a role"
            disabled={busy}
            className="h-9 text-xs"
            onChange={(event) => {
              const roleId = event.target.value;
              if (roleId === '') return;
              const role = roles.find((candidate) => candidate.id === roleId);
              run(() => assignRoleAction(userId, roleId), `Added ${role?.name ?? 'role'}`);
            }}
          >
            <option value="">Add a role…</option>
            {roles
              .filter((role) => !assigned.has(role.id))
              .map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
          </Select>

          <p className="text-[0.625rem] leading-relaxed text-ink-muted">
            You can only assign roles below your own rank, and only those whose permissions you hold
            yourself.
          </p>
        </Panel>
      ) : null}

      <ConfirmDialog
        open={dialog === 'grant'}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title="Grant whitelist access?"
        description="The player is notified and the game server is synchronised. If the server is unreachable the push is retried."
        confirmLabel="Grant"
        loading={busy}
        onConfirm={() => {
          run(() => grantWhitelistAction(userId, reason), 'Whitelist granted');
        }}
      />

      <ConfirmDialog
        open={dialog === 'revoke'}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title="Revoke whitelist access?"
        description="The player is notified with your reason and can appeal. They will not be able to connect once the game server has synchronised."
        confirmLabel="Revoke"
        tone="danger"
        loading={busy}
        onConfirm={() => {
          run(() => revokeWhitelistAction(userId, reason), 'Whitelist revoked');
        }}
      />

      <ConfirmDialog
        open={dialog === 'ban'}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title="Ban this account?"
        description="Every session is ended immediately and the account cannot sign in. Their roles are kept so this can be reversed. They can still file an appeal."
        confirmLabel="Ban"
        tone="danger"
        // The one place in the product that asks for typed confirmation.
        confirmPhrase={publicId}
        loading={busy}
        onConfirm={() => {
          run(() => setUserStatusAction(userId, 'BANNED', reason), 'Account banned');
        }}
      />

      <ConfirmDialog
        open={dialog === 'unban'}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title="Reinstate this account?"
        description="The player can sign in again and their roles take effect immediately."
        confirmLabel="Reinstate"
        loading={busy}
        onConfirm={() => {
          run(() => setUserStatusAction(userId, 'ACTIVE', reason), 'Account reinstated');
        }}
      />
    </>
  );
}
