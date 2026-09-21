'use client';

import { AlertTriangle, RefreshCw, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Badge, Button, Field, Input, Panel, Select, Switch, useToast } from '@xenon/ui';

import {
  deleteRoleMappingAction,
  resyncAllRolesAction,
  saveGuildAction,
  saveRoleMappingAction,
} from '~/app/(control)/control/discord/actions';
import { text } from '~/lib/form';

export interface GuildRecord {
  readonly id: string;
  readonly guildId: string;
  readonly name: string;
  readonly reviewChannelId: string | null;
  readonly announcementChannelId: string | null;
  readonly logChannelId: string | null;
  readonly memberCount: number | null;
  readonly syncedAt: string | null;
  readonly syncError: string | null;
}

export interface MappingRecord {
  readonly id: string;
  readonly roleId: string;
  readonly roleName: string;
  readonly discordRoleId: string;
  readonly discordRoleName: string | null;
  readonly syncToDiscord: boolean;
  readonly syncFromDiscord: boolean;
  readonly hierarchyBlocked: boolean;
  readonly lastError: string | null;
  readonly lastSyncedAt: string | null;
}

/**
 * Guild settings and role mappings.
 *
 * `syncFromDiscord` defaults off and stays off unless somebody deliberately
 * turns it on. Discord is not the source of truth, and adopting membership
 * from it is the one setting here that can quietly invert that.
 */
export function DiscordConfig({
  guild,
  envGuildId,
  roles,
  mappings,
}: {
  guild: GuildRecord | null;
  envGuildId: string;
  roles: readonly { id: string; key: string; name: string }[];
  mappings: readonly MappingRecord[];
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = React.useTransition();

  const mapped = new Set(mappings.map((mapping) => mapping.roleId));

  return (
    <div className="flex flex-col gap-6">
      <Panel tone="flat" pad="lg">
        <form
          className="flex flex-col gap-5"
          action={(form) => {
            startTransition(async () => {
              const result = await saveGuildAction({
                guildId: text(form, 'guildId'),
                name: text(form, 'name'),
                reviewChannelId: text(form, 'reviewChannelId'),
                announcementChannelId: text(form, 'announcementChannelId'),
                logChannelId: text(form, 'logChannelId'),
              });
              if (result.ok) {
                toast.success('Guild saved');
                router.refresh();
                return;
              }
              toast.error('Could not save', result.message);
            });
          }}
        >
          <div className="flex items-center justify-between gap-4">
            <h2 className="x-eyebrow">Guild</h2>
            {guild?.memberCount === null || guild === null ? null : (
              <span className="font-mono text-[0.625rem] text-ink-muted">
                {guild.memberCount} members · synced{' '}
                {guild.syncedAt === null
                  ? 'never'
                  : new Date(guild.syncedAt).toLocaleString('en-GB')}
              </span>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Server ID"
              htmlFor="guildId"
              required
              hint={`DISCORD_GUILD_ID is currently ${envGuildId}. They should match.`}
            >
              <Input
                name="guildId"
                defaultValue={guild?.guildId ?? envGuildId}
                maxLength={20}
                className="font-mono"
              />
            </Field>
            <Field label="Server name" htmlFor="name" required>
              <Input name="name" defaultValue={guild?.name ?? ''} maxLength={100} />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label="Review channel"
              htmlFor="reviewChannelId"
              hint="Where application cards are posted."
            >
              <Input
                name="reviewChannelId"
                defaultValue={guild?.reviewChannelId ?? ''}
                maxLength={20}
                className="font-mono"
              />
            </Field>
            <Field label="Announcements" htmlFor="announcementChannelId">
              <Input
                name="announcementChannelId"
                defaultValue={guild?.announcementChannelId ?? ''}
                maxLength={20}
                className="font-mono"
              />
            </Field>
            <Field label="Log channel" htmlFor="logChannelId">
              <Input
                name="logChannelId"
                defaultValue={guild?.logChannelId ?? ''}
                maxLength={20}
                className="font-mono"
              />
            </Field>
          </div>

          {guild?.syncError == null ? null : (
            <p className="rounded-md border border-danger/30 bg-danger/5 p-3 font-mono text-xs text-danger">
              {guild.syncError}
            </p>
          )}

          <div className="flex justify-end">
            <Button type="submit" variant="accent" size="sm" loading={pending}>
              Save guild
            </Button>
          </div>
        </form>
      </Panel>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <h2 className="x-eyebrow">Role mappings</h2>
          <Button
            variant="outline"
            size="sm"
            loading={pending}
            disabled={guild === null}
            onClick={() => {
              startTransition(async () => {
                const result = await resyncAllRolesAction();
                if (result.ok) {
                  toast.success(
                    'Reconciliation queued',
                    `${String(result.data.queued)} accounts queued. The bot works through them.`,
                  );
                  return;
                }
                toast.error('Could not queue', result.message);
              });
            }}
          >
            <RefreshCw /> Resync everybody
          </Button>
        </div>

        {guild === null ? (
          <Panel tone="flat" pad="lg">
            <p className="text-sm text-ink-muted">Save the guild first.</p>
          </Panel>
        ) : (
          <>
            <Panel tone="flat" pad="none" className="divide-y divide-line">
              {mappings.length === 0 ? (
                <p className="p-5 text-sm text-ink-muted">No roles are mapped yet.</p>
              ) : (
                mappings.map((mapping) => (
                  <MappingRow
                    key={mapping.id}
                    mapping={mapping}
                    guildRowId={guild.id}
                    pending={pending}
                    onSave={(payload) => {
                      startTransition(async () => {
                        const result = await saveRoleMappingAction(payload);
                        if (result.ok) {
                          toast.success('Mapping updated');
                          router.refresh();
                          return;
                        }
                        toast.error('Could not save', result.message);
                      });
                    }}
                    onDelete={() => {
                      startTransition(async () => {
                        const result = await deleteRoleMappingAction(mapping.id);
                        if (result.ok) {
                          toast.success('Mapping removed');
                          router.refresh();
                          return;
                        }
                        toast.error('Could not remove', result.message);
                      });
                    }}
                  />
                ))
              )}
            </Panel>

            <Panel tone="flat" pad="lg">
              <form
                className="flex flex-wrap items-end gap-3"
                action={(form) => {
                  startTransition(async () => {
                    const result = await saveRoleMappingAction({
                      guildId: guild.id,
                      roleId: text(form, 'roleId'),
                      discordRoleId: text(form, 'discordRoleId'),
                      discordRoleName: text(form, 'discordRoleName'),
                      syncToDiscord: true,
                      syncFromDiscord: false,
                    });
                    if (result.ok) {
                      toast.success('Mapping added');
                      router.refresh();
                      return;
                    }
                    toast.error('Could not add', result.message);
                  });
                }}
              >
                <Field label="Xenon role" htmlFor="roleId" className="min-w-44 flex-1">
                  <Select name="roleId" required>
                    {roles
                      .filter((role) => !mapped.has(role.id))
                      .map((role) => (
                        <option key={role.id} value={role.id}>
                          {role.name}
                        </option>
                      ))}
                  </Select>
                </Field>
                <Field label="Discord role ID" htmlFor="discordRoleId" className="min-w-44 flex-1">
                  <Input name="discordRoleId" required maxLength={20} className="font-mono" />
                </Field>
                <Field label="Label" htmlFor="discordRoleName" className="min-w-36 flex-1">
                  <Input name="discordRoleName" maxLength={100} placeholder="Optional" />
                </Field>
                <Button type="submit" variant="accent" size="md" loading={pending}>
                  Add mapping
                </Button>
              </form>
            </Panel>
          </>
        )}
      </section>
    </div>
  );
}

function MappingRow({
  mapping,
  guildRowId,
  pending,
  onSave,
  onDelete,
}: {
  mapping: MappingRecord;
  guildRowId: string;
  pending: boolean;
  onSave: (payload: Record<string, unknown>) => void;
  onDelete: () => void;
}): React.ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-4 p-4">
      <span className="min-w-32 text-sm text-ink">{mapping.roleName}</span>

      <code className="min-w-40 font-mono text-[0.6875rem] text-ink-muted">
        {mapping.discordRoleName ?? mapping.discordRoleId}
      </code>

      {mapping.hierarchyBlocked ? (
        <Badge tone="danger">
          <AlertTriangle className="size-3" /> Above the bot
        </Badge>
      ) : mapping.lastError !== null ? (
        <Badge tone="warning">Error</Badge>
      ) : mapping.lastSyncedAt !== null ? (
        <Badge tone="success">Synced</Badge>
      ) : (
        <Badge tone="neutral">Never synced</Badge>
      )}

      <span className="ml-auto flex items-center gap-4">
        <label className="flex items-center gap-2 text-[0.6875rem] text-ink-muted">
          <Switch
            checked={mapping.syncToDiscord}
            label="Push to Discord"
            onCheckedChange={(next) => {
              onSave({
                guildId: guildRowId,
                roleId: mapping.roleId,
                discordRoleId: mapping.discordRoleId,
                discordRoleName: mapping.discordRoleName ?? '',
                syncToDiscord: next,
                syncFromDiscord: mapping.syncFromDiscord,
              });
            }}
          />
          push
        </label>

        <Button
          variant="ghost"
          size="icon"
          disabled={pending}
          onClick={onDelete}
          aria-label="Remove mapping"
        >
          <Trash2 />
        </Button>
      </span>

      {mapping.lastError === null ? null : (
        <p className="w-full font-mono text-[0.625rem] text-danger">{mapping.lastError}</p>
      )}
    </div>
  );
}
