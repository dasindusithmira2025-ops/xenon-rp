'use client';

import { Check, Lock, Minus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Badge, Button, cn, Tooltip, useToast } from '@xenon/ui';

import { setRolePermissionsAction } from '~/app/(control)/control/actions';

/**
 * The permission matrix.
 *
 * Capabilities down, roles across. This is the clearest way to answer the
 * question staff actually ask - "who can approve applications" - which a
 * per-role edit screen cannot, because it shows one column at a time.
 *
 * Two rules are enforced visually and again in the service:
 *
 *  - You cannot grant a capability you do not hold yourself. Those cells are
 *    locked rather than hidden, so the structure stays legible.
 *  - Owner is shown but not editable. It holds everything by definition, and
 *    the seed re-asserts that on every deploy.
 *
 * Changes are staged locally and saved per role, so toggling six capabilities
 * is one write and one audit entry rather than six.
 */

export interface MatrixRole {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly priority: number;
  readonly isSystem: boolean;
  readonly memberCount: number;
  readonly permissions: readonly string[];
}

export interface MatrixCategory {
  readonly key: string;
  readonly label: string;
  readonly permissions: readonly { key: string; description: string }[];
}

export function PermissionMatrix({
  roles,
  categories,
  canManage,
  heldByViewer,
  isOwner,
}: {
  roles: readonly MatrixRole[];
  categories: readonly MatrixCategory[];
  canManage: boolean;
  heldByViewer: readonly string[];
  isOwner: boolean;
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = React.useTransition();

  const [draft, setDraft] = React.useState<Record<string, Set<string>>>(() =>
    Object.fromEntries(roles.map((role) => [role.id, new Set(role.permissions)])),
  );

  const held = React.useMemo(() => new Set(heldByViewer), [heldByViewer]);

  const dirty = React.useMemo(() => {
    const changed = new Set<string>();
    for (const role of roles) {
      const current = draft[role.id] ?? new Set<string>();
      const original = new Set(role.permissions);
      if (current.size !== original.size || [...current].some((key) => !original.has(key))) {
        changed.add(role.id);
      }
    }
    return changed;
  }, [draft, roles]);

  const toggle = (roleId: string, permission: string): void => {
    setDraft((current) => {
      const next = new Set(current[roleId] ?? []);
      if (next.has(permission)) next.delete(permission);
      else next.add(permission);
      return { ...current, [roleId]: next };
    });
  };

  const save = (roleId: string): void => {
    startTransition(async () => {
      const result = await setRolePermissionsAction(roleId, [...(draft[roleId] ?? [])]);
      if (result.ok) {
        toast.success('Role updated');
        router.refresh();
        return;
      }
      toast.error('Could not save', result.message);
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="relative w-full overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-elevated/95 backdrop-blur-sm">
            <tr className="border-b border-line-strong">
              <th
                scope="col"
                className="x-eyebrow sticky left-0 z-20 min-w-64 bg-elevated px-3 py-3 text-left"
              >
                Capability
              </th>
              {roles.map((role) => (
                <th key={role.id} scope="col" className="px-2 py-3 text-center align-bottom">
                  <span className="flex flex-col items-center gap-1">
                    <span className="text-[0.6875rem] font-medium whitespace-nowrap text-ink">
                      {role.name}
                    </span>
                    <span className="font-mono text-[0.5625rem] text-ink-muted">
                      {role.memberCount}
                    </span>
                    {role.key === 'owner' ? <Lock className="size-3 text-ink-muted" /> : null}
                  </span>
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {categories.map((category) => (
              <React.Fragment key={category.key}>
                <tr className="border-b border-line bg-black/40">
                  <th
                    scope="colgroup"
                    colSpan={roles.length + 1}
                    className="x-eyebrow sticky left-0 px-3 py-2 text-left text-xenon"
                  >
                    {category.label}
                  </th>
                </tr>

                {category.permissions.map((permission) => (
                  <tr key={permission.key} className="border-b border-line hover:bg-elevated/40">
                    <th
                      scope="row"
                      className="sticky left-0 z-10 bg-surface px-3 py-2 text-left font-normal"
                    >
                      <Tooltip content={permission.description}>
                        <span className="font-mono text-[0.6875rem] text-ink-secondary">
                          {permission.key}
                        </span>
                      </Tooltip>
                    </th>

                    {roles.map((role) => {
                      const granted = draft[role.id]?.has(permission.key) ?? false;
                      // Owner is definitional; a capability the viewer lacks is
                      // not theirs to hand out.
                      const locked =
                        !canManage ||
                        role.key === 'owner' ||
                        (!isOwner && !held.has(permission.key));

                      return (
                        <td key={role.id} className="px-2 py-2 text-center">
                          <button
                            type="button"
                            disabled={locked || pending}
                            aria-label={`${granted ? 'Revoke' : 'Grant'} ${permission.key} for ${role.name}`}
                            aria-pressed={granted}
                            onClick={() => {
                              toggle(role.id, permission.key);
                            }}
                            className={cn(
                              'inline-flex size-5 items-center justify-center rounded-xs border transition-colors',
                              granted
                                ? 'border-xenon bg-xenon text-ink-inverse'
                                : 'border-line-strong bg-black text-transparent',
                              locked ? 'cursor-not-allowed opacity-45' : 'hover:border-xenon/60',
                            )}
                          >
                            {granted ? (
                              <Check className="size-3" />
                            ) : (
                              <Minus className="size-3 text-line-strong" />
                            )}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {canManage ? (
        <div className="flex flex-wrap items-center gap-3">
          {dirty.size === 0 ? (
            <p className="text-xs text-ink-muted">No unsaved changes.</p>
          ) : (
            <>
              <p className="text-xs text-warning">
                {dirty.size} role{dirty.size === 1 ? '' : 's'} changed and not saved.
              </p>
              {[...dirty].map((roleId) => {
                const role = roles.find((candidate) => candidate.id === roleId);
                return (
                  <Button
                    key={roleId}
                    variant="accent"
                    size="sm"
                    loading={pending}
                    onClick={() => {
                      save(roleId);
                    }}
                  >
                    Save {role?.name ?? 'role'}
                  </Button>
                );
              })}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDraft(
                    Object.fromEntries(roles.map((role) => [role.id, new Set(role.permissions)])),
                  );
                }}
              >
                Discard
              </Button>
            </>
          )}
        </div>
      ) : (
        <Badge tone="neutral">Read only — you do not hold staff.manage</Badge>
      )}
    </div>
  );
}
