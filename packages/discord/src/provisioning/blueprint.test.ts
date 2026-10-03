import { PermissionFlagsBits as P } from 'discord.js';
import { describe, expect, it } from 'vitest';

import { buildDesiredState, desiredKeys, type DepartmentInput } from './blueprint';
import { parseDepartmentSpace, parseFeatures } from './config';
import { auditDesiredState } from './effective';
import { resolvePolicy } from './policies';
import { blueprintContext } from './testing';

const lspd: DepartmentInput = {
  slug: 'lspd',
  name: 'Los Santos Police Department',
  shortName: 'LSPD',
  accentColour: '#3B6FB6',
  roleKey: 'lspd_officer',
  recruitmentState: 'OPEN',
  published: true,
  space: parseDepartmentSpace({ enabled: true, publicInfo: true }),
};

describe('blueprint integrity', () => {
  const state = buildDesiredState(blueprintContext({ departments: [lspd] }));

  it('has unique, well-formed logical keys', () => {
    const keys = desiredKeys(state);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys)
      expect(key).toMatch(
        /^(role|category|channel|voice|panel|emoji|sticker|automod)\.[a-z0-9._-]+$/,
      );
  });

  it('is stable: the same context yields the same state', () => {
    const again = buildDesiredState(blueprintContext({ departments: [lspd] }));
    expect(desiredKeys(again)).toEqual(desiredKeys(state));
  });

  it('only references categories that exist', () => {
    const categories = new Set(
      state.channels.filter((c) => c.kind === 'category').map((c) => c.key),
    );
    for (const channel of state.channels.filter((c) => c.parent !== undefined)) {
      expect(categories.has(channel.parent ?? ''), channel.key).toBe(true);
    }
  });

  it('only grants to roles that exist', () => {
    const roles = new Set(['@everyone', 'bot', ...state.roles.map((role) => role.key)]);
    for (const channel of state.channels) {
      for (const overwrite of channel.overwrites)
        expect(roles.has(overwrite.id), `${channel.key} → ${overwrite.id}`).toBe(true);
    }
  });

  it('only names policies that resolve', () => {
    for (const channel of state.channels)
      if (channel.policy !== undefined)
        expect(() => resolvePolicy(channel.policy ?? '')).not.toThrow();
  });

  it('places every panel in a blueprint channel', () => {
    const channels = new Set(state.channels.map((channel) => channel.key));
    for (const panel of state.panels) expect(channels.has(panel.channel), panel.key).toBe(true);
  });

  it('passes its own critical permission tests', () => {
    const audit = auditDesiredState(state);
    expect(audit.diagnostics.filter((d) => d.severity === 'critical')).toEqual([]);
    expect(audit.passed).toBe(true);
  });
});

describe('safe defaults', () => {
  const state = buildDesiredState(blueprintContext());

  it('never grants permissions through self-assignable roles', () => {
    const selfAssignable = state.roles.filter((role) => role.selfAssignable);
    expect(selfAssignable.length).toBeGreaterThan(0);
    for (const role of selfAssignable) {
      expect(role.permissions, role.key).toBe(0n);
      expect(role.mentionable, role.key).toBe(false);
      expect(role.tier === 'notification' || role.tier === 'language').toBe(true);
    }
  });

  it('never grants Administrator or server management to any role', () => {
    for (const role of state.roles) {
      expect(
        role.permissions & (P.Administrator | P.ManageGuild | P.ManageRoles | P.ManageChannels),
        role.key,
      ).toBe(0n);
    }
  });

  it('hides staff and operations areas from @everyone', () => {
    for (const key of ['category.staff', 'category.ops']) {
      const category = state.channels.find((channel) => channel.key === key);
      const everyone = category?.overwrites.find((overwrite) => overwrite.id === '@everyone');
      expect(everyone === undefined ? 0n : everyone.deny & P.ViewChannel, key).toBe(P.ViewChannel);
    }
  });

  it('uses Xenon green on exactly one role', () => {
    expect(state.roles.filter((role) => role.color === 0x2afd23).map((role) => role.key)).toEqual([
      'role.whitelisted',
    ]);
  });

  it('does not hardcode any department', () => {
    expect(desiredKeys(state).some((key) => key.includes('.dept.'))).toBe(false);
    expect(state.channels.some((channel) => channel.key === 'channel.departments')).toBe(false);
  });

  it('keeps optional channels off by default and fewer channels over more', () => {
    const names = state.channels.map((channel) => channel.name);
    expect(names).not.toContain('off-topic');
    expect(names).not.toContain('introductions');
    expect(names).toContain('general');
  });

  it('routes review cards, announcements and logs to provisioned channels', () => {
    const integrations = Object.fromEntries(
      state.channels.flatMap((channel) =>
        channel.integration === undefined ? [] : [[channel.integration, channel.key] as const],
      ),
    );
    expect(integrations).toEqual({
      reviewChannel: 'channel.whitelist-review',
      announcementChannel: 'channel.announcements',
      logChannel: 'channel.bot-ops',
    });
  });

  it('scopes the bot’s channel management to the temporary voice category', () => {
    const managing = state.channels.filter((channel) =>
      channel.overwrites.some(
        (overwrite) => overwrite.id === 'bot' && (overwrite.allow & P.ManageChannels) !== 0n,
      ),
    );
    expect(managing.map((channel) => channel.key).sort()).toEqual([
      'category.voice',
      'voice.afk',
      'voice.chill',
      'voice.create-room',
      'voice.gaming',
      'voice.general',
    ]);
  });
});

describe('capabilities and features', () => {
  it('falls back from forum and announcement channels without Community', () => {
    const state = buildDesiredState(blueprintContext({ guildFeatures: [] }));
    const suggestions = state.channels.find((channel) => channel.key === 'channel.suggestions');
    const announcements = state.channels.find((channel) => channel.key === 'channel.announcements');
    expect(suggestions?.effectiveKind).toBe('text');
    expect(announcements?.effectiveKind).toBe('text');
    expect(state.fallbacks.map((fallback) => fallback.key)).toEqual(
      expect.arrayContaining(['channel.suggestions', 'channel.announcements']),
    );
    expect(state.manualSetup.map((step) => step.key)).toContain('manual.community');
  });

  it('keeps native kinds when Community is enabled', () => {
    const state = buildDesiredState(blueprintContext());
    expect(
      state.channels.find((channel) => channel.key === 'channel.suggestions')?.effectiveKind,
    ).toBe('forum');
  });

  it('adds optional channels and language roles only when switched on', () => {
    const state = buildDesiredState(
      blueprintContext({
        features: parseFeatures({ offTopic: true, languageRoles: true, automod: true }),
      }),
    );
    expect(state.channels.some((channel) => channel.key === 'channel.off-topic')).toBe(true);
    expect(state.roles.filter((role) => role.tier === 'language')).toHaveLength(3);
    expect(state.automod).toHaveLength(3);
    expect(state.channels.some((channel) => channel.key === 'channel.mod-alerts')).toBe(true);
  });

  it('drops a category whose channels are all disabled', () => {
    const state = buildDesiredState(
      blueprintContext({ features: parseFeatures({ recruitment: false, whitelistInfo: false }) }),
    );
    expect(state.channels.some((channel) => channel.key === 'category.applications')).toBe(true);
    const cityInfo = buildDesiredState(blueprintContext());
    expect(cityInfo.channels.some((channel) => channel.key === 'category.city-info')).toBe(false);
  });

  it('always documents onboarding as manual rather than faking it', () => {
    const state = buildDesiredState(blueprintContext());
    const onboarding = state.manualSetup.find((step) => step.key === 'manual.onboarding');
    expect(onboarding?.steps.join(' ')).toContain('Never offer criminal organisations');
  });
});

describe('department template', () => {
  it('expands a department from its record', () => {
    const state = buildDesiredState(blueprintContext({ departments: [lspd] }));
    const keys = desiredKeys(state);
    expect(keys).toEqual(
      expect.arrayContaining([
        'role.dept.lspd.member',
        'role.dept.lspd.command',
        'category.dept.lspd',
        'channel.dept.lspd.announcements',
        'channel.dept.lspd.general',
        'channel.dept.lspd.command',
        'voice.dept.lspd.operations',
        'channel.dept.lspd.info',
        'channel.dept.lspd.recruitment',
        'panel.dept.lspd.recruitment',
      ]),
    );
    expect(state.roles.find((role) => role.key === 'role.dept.lspd.member')?.xenonRoleKey).toBe(
      'lspd_officer',
    );
    expect(state.roles.find((role) => role.key === 'role.dept.lspd.member')?.color).toBe(0x3b6fb6);
  });

  it('creates nothing for a department whose Discord space is disabled', () => {
    const state = buildDesiredState(
      blueprintContext({ departments: [{ ...lspd, space: parseDepartmentSpace({}) }] }),
    );
    expect(desiredKeys(state).some((key) => key.includes('.dept.'))).toBe(false);
  });

  it('keeps department members out of the command channel', () => {
    const state = buildDesiredState(blueprintContext({ departments: [lspd] }));
    const command = state.channels.find((channel) => channel.key === 'channel.dept.lspd.command');
    expect(command?.overwrites.some((overwrite) => overwrite.id === 'role.dept.lspd.member')).toBe(
      false,
    );
    expect(command?.visibility).toEqual({ scope: 'department-command', slug: 'lspd' });
  });
});

describe('organisation template', () => {
  const org = {
    key: 'ballas',
    name: 'The Ballas',
    kind: 'STREET_GANG' as const,
    staffVisible: false,
    publicMembership: false,
    archived: false,
  };

  it('never names a private organisation on its role', () => {
    const state = buildDesiredState(blueprintContext({ organizations: [org] }));
    const role = state.roles.find((candidate) => candidate.key === 'role.org.ballas');
    expect(role?.name).toMatch(/^Private Space [0-9A-F]{4}$/);
    expect(role?.hoist).toBe(false);
  });

  it('hides the space from everyone, including management when not staff-visible', () => {
    const state = buildDesiredState(blueprintContext({ organizations: [org] }));
    const category = state.channels.find((channel) => channel.key === 'category.org.ballas');
    expect(category?.overwrites.map((overwrite) => overwrite.id).sort()).toEqual([
      '@everyone',
      'bot',
      'role.org.ballas',
    ]);
    expect(auditDesiredState(state).passed).toBe(true);
  });

  it('archives by locking to management read-only and dropping the role, never by deleting', () => {
    const state = buildDesiredState(
      blueprintContext({ organizations: [{ ...org, archived: true }] }),
    );
    const category = state.channels.find((channel) => channel.key === 'category.org.ballas');
    expect(category?.policy).toBe('ARCHIVED');
    expect(category?.name).toMatch(/^🗄️ Archived/);
    expect(state.roles.some((role) => role.key === 'role.org.ballas')).toBe(false);
    expect(state.channels.some((channel) => channel.key === 'channel.org.ballas.general')).toBe(
      true,
    );
  });
});
