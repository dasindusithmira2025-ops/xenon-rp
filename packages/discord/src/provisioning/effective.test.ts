import { PermissionFlagsBits as P } from 'discord.js';
import { describe, expect, it } from 'vitest';

import { buildDesiredState, type DepartmentInput } from './blueprint';
import { parseDepartmentSpace } from './config';
import { auditDesiredState, channelPermissions } from './effective';
import { blueprintContext } from './testing';

import type { DesiredState, Overwrite } from './types';

const model = {
  everyoneId: 'everyone',
  rolePermissions: new Map([
    ['everyone', P.ViewChannel | P.SendMessages],
    ['staff', 0n],
    ['admin', P.Administrator],
  ]),
};

describe('channelPermissions', () => {
  it('applies @everyone, then roles (deny before allow), then the member', () => {
    const overwrites: Overwrite[] = [
      { id: 'everyone', type: 'role', allow: 0n, deny: P.ViewChannel },
      { id: 'staff', type: 'role', allow: P.ViewChannel, deny: 0n },
      { id: 'member-1', type: 'member', allow: 0n, deny: P.SendMessages },
    ];
    expect(channelPermissions(model, overwrites, []) & P.ViewChannel).toBe(0n);
    expect(channelPermissions(model, overwrites, ['staff']) & P.ViewChannel).toBe(P.ViewChannel);
    expect(channelPermissions(model, overwrites, ['staff'], 'member-1') & P.SendMessages).toBe(0n);
  });

  it('lets Administrator bypass every overwrite', () => {
    const overwrites: Overwrite[] = [
      { id: 'everyone', type: 'role', allow: 0n, deny: P.ViewChannel },
    ];
    expect(channelPermissions(model, overwrites, ['admin']) & P.ViewChannel).toBe(P.ViewChannel);
  });
});

function tamper(
  state: DesiredState,
  key: string,
  change: (overwrites: readonly Overwrite[]) => Overwrite[],
): DesiredState {
  return {
    ...state,
    channels: state.channels.map((channel) =>
      channel.key === key ? { ...channel, overwrites: change(channel.overwrites) } : channel,
    ),
  };
}

function leaks(state: DesiredState): string[] {
  return auditDesiredState(state)
    .diagnostics.filter((diagnostic) => diagnostic.severity === 'critical')
    .map((diagnostic) => `${diagnostic.code} ${diagnostic.key ?? ''}`);
}

const lspd: DepartmentInput = {
  slug: 'lspd',
  name: 'LSPD',
  shortName: 'LSPD',
  accentColour: null,
  roleKey: null,
  recruitmentState: 'OPEN',
  published: true,
  space: parseDepartmentSpace({ enabled: true }),
};

describe('critical access tests', () => {
  const base = buildDesiredState(
    blueprintContext({
      departments: [lspd],
      organizations: [
        {
          key: 'crew',
          name: 'Crew',
          kind: 'CREW',
          staffVisible: true,
          publicMembership: false,
          archived: false,
        },
      ],
    }),
  );

  it('passes for the untouched blueprint', () => {
    expect(leaks(base)).toEqual([]);
  });

  it('fails when @everyone can see Staff HQ', () => {
    const state = tamper(base, 'category.staff', (overwrites) =>
      overwrites.map((o) => (o.id === '@everyone' ? { ...o, allow: P.ViewChannel, deny: 0n } : o)),
    );
    expect(leaks(state)).toContain('PERMISSION_LEAK category.staff');
  });

  it('fails when Citizen can see whitelist review', () => {
    const state = tamper(base, 'channel.whitelist-review', (overwrites) => [
      ...overwrites,
      { id: 'role.citizen', type: 'role', allow: P.ViewChannel, deny: 0n },
    ]);
    expect(leaks(state)).toContain('PERMISSION_LEAK channel.whitelist-review');
  });

  it('fails when a moderator can see a management-only channel', () => {
    const state = tamper(base, 'channel.bot-ops', (overwrites) => [
      ...overwrites,
      { id: 'role.staff.moderator', type: 'role', allow: P.ViewChannel, deny: 0n },
    ]);
    expect(leaks(state)).toContain('PERMISSION_LEAK channel.bot-ops');
  });

  it('fails when a department member can manage roles', () => {
    const state: DesiredState = {
      ...base,
      roles: base.roles.map((role) =>
        role.key === 'role.dept.lspd.member' ? { ...role, permissions: P.ManageRoles } : role,
      ),
    };
    expect(leaks(state)).toContain('DANGEROUS_ROLE_PERMISSION role.dept.lspd.member');
  });

  it('fails when a notification role grants channel access', () => {
    const state = tamper(base, 'channel.general', (overwrites) => [
      ...overwrites,
      { id: 'role.notify.events', type: 'role', allow: P.ManageMessages, deny: 0n },
    ]);
    expect(leaks(state)).toContain('DANGEROUS_ROLE_PERMISSION channel.general');
  });

  it('fails when an organisation space is public', () => {
    const state = tamper(base, 'category.org.crew', (overwrites) =>
      overwrites.map((o) => (o.id === '@everyone' ? { ...o, allow: P.ViewChannel, deny: 0n } : o)),
    );
    expect(leaks(state)).toContain('PERMISSION_LEAK category.org.crew');
  });

  it('fails when a department channel is visible to another department', () => {
    const state = tamper(base, 'category.dept.lspd', (overwrites) => [
      ...overwrites,
      { id: 'role.whitelisted', type: 'role', allow: P.ViewChannel, deny: 0n },
    ]);
    expect(leaks(state)).toContain('PERMISSION_LEAK category.dept.lspd');
  });

  it('builds an access matrix that answers who can see what', () => {
    const matrix = auditDesiredState(base).matrix;
    const staff = matrix.find((row) => row.key === 'category.staff');
    const viewers = staff?.access.filter((entry) => entry.view).map((entry) => entry.persona);
    expect(viewers).toEqual(expect.arrayContaining(['Management', 'Moderator', 'Xenon Bot']));
    expect(viewers).not.toContain('@everyone');
    expect(viewers).not.toContain('Whitelisted');
  });
});
