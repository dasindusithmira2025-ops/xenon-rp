import { PermissionFlagsBits as P } from 'discord.js';
import { describe, expect, it } from 'vitest';

import { buildDesiredState, type DepartmentInput, type OrganizationInput } from './blueprint';
import { cleanupRun } from './cleanup';
import { parseDepartmentSpace, parseFeatures } from './config';
import { memoryRegistry } from './ports';
import { blueprintContext, executeOnce, FakeGuild, planOnce } from './testing';

import type { DesiredState } from './types';

/**
 * The whole engine against an in-memory guild: plan → apply → status →
 * repair → cleanup. No test here can reach Discord.
 */

async function provisioned(state: DesiredState = buildDesiredState(blueprintContext())) {
  const guild = new FakeGuild();
  const store = memoryRegistry();
  const { result } = await executeOnce(guild, store, state);
  return { guild, store, state, result };
}

function mutations(guild: FakeGuild): string[] {
  return guild.calls.filter((call) => !call.startsWith('orderRoles'));
}

describe('apply', () => {
  it('builds the whole server, records every id and passes live validation', async () => {
    const { guild, store, state, result } = await provisioned();

    expect(result.failed).toEqual([]);
    expect(result.aborted).toBe(false);
    expect(guild.channelByName('whitelist-review')).toBeDefined();
    expect(guild.channelByName('bot-logs')).toBeDefined();
    expect(guild.roleByName('Whitelisted')?.color).toBe(0x2afd23);
    const keys = new Set([...store.entries.keys()]);
    for (const key of [...state.roles, ...state.channels, ...state.panels].map(
      (resource) => resource.key,
    )) {
      expect(keys.has(key), key).toBe(true);
    }
    const after = await planOnce(guild, store, state);
    expect(after.liveAudit.passed).toBe(true);
    expect(guild.calls.some((call) => call.startsWith('delete'))).toBe(false);
  });

  it('is idempotent: a second run changes nothing and creates no duplicates', async () => {
    const { guild, store, state } = await provisioned();
    const channels = guild.channels.size;
    const roles = guild.roles.size;
    guild.calls.length = 0;

    const second = await planOnce(guild, store, state);
    expect(
      second.counts.create +
        second.counts.update +
        second.counts.permission +
        second.counts.move +
        second.counts.drift,
    ).toBe(0);

    await executeOnce(guild, store, state);
    expect(mutations(guild)).toEqual([]);
    expect(guild.channels.size).toBe(channels);
    expect(guild.roles.size).toBe(roles);
  });

  it('posts panels once and edits them in place when content changes', async () => {
    const { guild, store, state } = await provisioned();
    const welcome = guild.channelByName('welcome');
    expect(welcome?.messages.size).toBe(1);

    // Simulate content that changed since it was posted (a new rules version,
    // new links): the recorded hash no longer matches the rendered panel.
    const entry = store.entries.get('panel.welcome');
    if (entry === undefined) throw new Error('missing');
    store.entries.set('panel.welcome', { ...entry, contentHash: 'stale' });

    const plan = await planOnce(guild, store, state);
    expect(plan.items.find((item) => item.key === 'panel.welcome')?.kind).toBe('UPDATE');
    guild.calls.length = 0;
    await executeOnce(guild, store, state);
    expect(guild.calls).toContain(`editMessage:${entry.discordId ?? ''}`);
    expect(welcome?.messages.size).toBe(1);
  });
});

describe('partial failure and resume', () => {
  it('records what succeeded and resumes without duplicating it', async () => {
    const guild = new FakeGuild();
    const store = memoryRegistry();
    const state = buildDesiredState(blueprintContext());
    guild.failOn = (operation, subject) => operation === 'createChannel' && subject === 'general';

    const first = await executeOnce(guild, store, state);
    expect(first.result.failed.map((failure) => failure.key)).toEqual(['channel.general']);
    expect(guild.channelByName('rules')).toBeDefined();

    guild.failOn = null;
    const second = await executeOnce(guild, store, state);
    expect(
      second.plan.items.filter((item) => item.kind === 'CREATE').map((item) => item.key),
    ).toEqual(['channel.general']);
    expect(
      [...guild.channels.values()].filter((channel) => channel.name === 'general'),
    ).toHaveLength(1);
    expect([...guild.channels.values()].filter((channel) => channel.name === 'rules')).toHaveLength(
      1,
    );
  });

  it('stops after repeated failures instead of hammering Discord', async () => {
    const guild = new FakeGuild();
    guild.failOn = (operation) => operation === 'createRole';
    const { result } = await executeOnce(
      guild,
      memoryRegistry(),
      buildDesiredState(blueprintContext()),
      { maxConsecutiveFailures: 3 },
    );
    expect(result.aborted).toBe(true);
    expect(result.failed).toHaveLength(3);
    expect(guild.channels.size).toBe(0);
  });
});

describe('drift and repair', () => {
  it('detects a deleted channel, leaves it to repair, and repair restores it once', async () => {
    const { guild, store, state } = await provisioned();
    const general = guild.channelByName('general');
    if (general === undefined) throw new Error('missing');
    guild.channels.delete(general.id);

    const status = await planOnce(guild, store, state);
    expect(status.items.find((item) => item.key === 'channel.general')?.kind).toBe('DRIFT');

    guild.calls.length = 0;
    await executeOnce(guild, store, state); // apply does not fight
    expect(guild.channelByName('general')).toBeUndefined();

    await executeOnce(guild, store, state, { mode: 'repair' });
    expect(
      [...guild.channels.values()].filter((channel) => channel.name === 'general'),
    ).toHaveLength(1);
    expect((await planOnce(guild, store, state)).counts.drift).toBe(0);
  });

  it('treats a renamed role as soft drift that repair only restores on request', async () => {
    const { guild, store, state } = await provisioned();
    const role = guild.roleByName('Whitelisted');
    if (role === undefined) throw new Error('missing');
    guild.roles.set(role.id, { ...role, name: 'Verified Citizens' });

    const status = await planOnce(guild, store, state);
    const item = status.items.find((candidate) => candidate.key === 'role.whitelisted');
    expect(item?.kind).toBe('DRIFT');
    expect(item?.strictDrift).toBe(false);

    await executeOnce(guild, store, state, { mode: 'repair' });
    expect(guild.roles.get(role.id)?.name).toBe('Verified Citizens');

    await executeOnce(guild, store, state, { mode: 'repair', includeSoft: true });
    expect(guild.roles.get(role.id)?.name).toBe('Whitelisted');
  });

  it('respects a customised topic on apply', async () => {
    const { guild, store, state } = await provisioned();
    const general = guild.channelByName('general');
    if (general === undefined) throw new Error('missing');
    guild.channels.set(general.id, { ...general, topic: 'Our own words' });

    await executeOnce(guild, store, state);
    expect(guild.channels.get(general.id)?.topic).toBe('Our own words');
  });

  it('restores a channel moved out of its category', async () => {
    const { guild, store, state } = await provisioned();
    const review = guild.channelByName('whitelist-review');
    const community = [...guild.channels.values()].find(
      (channel) => channel.name === '💬 Community',
    );
    if (review === undefined || community === undefined) throw new Error('missing');
    const staffId = review.parentId;
    guild.channels.set(review.id, { ...review, parentId: community.id });

    const status = await planOnce(guild, store, state);
    expect(status.items.find((item) => item.key === 'channel.whitelist-review')).toMatchObject({
      kind: 'DRIFT',
      strictDrift: true,
    });

    await executeOnce(guild, store, state, { mode: 'repair' });
    expect(guild.channels.get(review.id)?.parentId).toBe(staffId);
  });

  it('fails live validation when staff permissions are opened to everyone, and repair closes them', async () => {
    const { guild, store, state } = await provisioned();
    const staff = [...guild.channels.values()].find((channel) => channel.name === '🛡️ Staff HQ');
    if (staff === undefined) throw new Error('missing');
    guild.channels.set(staff.id, {
      ...staff,
      overwrites: staff.overwrites.map((o) =>
        o.id === guild.id ? { ...o, allow: P.ViewChannel, deny: 0n } : o,
      ),
    });

    const status = await planOnce(guild, store, state);
    expect(status.liveAudit.passed).toBe(false);
    expect(
      status.diagnostics.some((d) => d.code === 'PERMISSION_LEAK' && d.key === 'category.staff'),
    ).toBe(true);

    await executeOnce(guild, store, state, { mode: 'repair' });
    expect((await planOnce(guild, store, state)).liveAudit.passed).toBe(true);
  });

  it('reposts a deleted panel on repair', async () => {
    const { guild, store, state } = await provisioned();
    const status = guild.channelByName('city-status');
    if (status === undefined) throw new Error('missing');
    status.messages.clear();

    expect(
      (await planOnce(guild, store, state)).items.find((item) => item.key === 'panel.city-status')
        ?.kind,
    ).toBe('DRIFT');
    await executeOnce(guild, store, state, { mode: 'repair' });
    expect(status.messages.size).toBe(1);
  });

  it('restricts enforcement to the keys it was given', async () => {
    const { guild, store, state } = await provisioned();
    for (const name of ['general', 'whitelist-review']) {
      const channel = guild.channelByName(name);
      if (channel !== undefined) guild.channels.delete(channel.id);
    }
    await executeOnce(guild, store, state, {
      mode: 'repair',
      onlyKeys: new Set(['channel.whitelist-review']),
    });
    expect(guild.channelByName('whitelist-review')).toBeDefined();
    expect(guild.channelByName('general')).toBeUndefined();
  });
});

describe('blueprint evolution', () => {
  it('turns a blueprint change into an UPDATE the next apply performs', async () => {
    const { guild, store, state } = await provisioned();
    const next: DesiredState = {
      ...state,
      roles: state.roles.map((role) =>
        role.key === 'role.staff.events' ? { ...role, color: 0x123456 } : role,
      ),
    };
    const plan = await planOnce(guild, store, next);
    expect(plan.items.find((item) => item.key === 'role.staff.events')?.kind).toBe('UPDATE');
    await executeOnce(guild, store, next);
    expect(guild.roleByName('Event Team')?.color).toBe(0x123456);
  });

  it('adds a newly enabled feature without touching the rest', async () => {
    const { guild, store } = await provisioned();
    const next = buildDesiredState(
      blueprintContext({ features: parseFeatures({ offTopic: true }) }),
    );
    const plan = await planOnce(guild, store, next);
    expect(plan.items.filter((item) => item.kind === 'CREATE').map((item) => item.key)).toEqual([
      'channel.off-topic',
    ]);
  });
});

describe('department and organisation spaces', () => {
  const ems: DepartmentInput = {
    slug: 'ems',
    name: 'Emergency Medical Services',
    shortName: 'EMS',
    accentColour: '#C0392B',
    roleKey: 'ems',
    recruitmentState: 'OPEN',
    published: true,
    space: parseDepartmentSpace({ enabled: true, recruitment: true }),
  };

  it('previews and then provisions a department space', async () => {
    const { guild, store } = await provisioned();
    const next = buildDesiredState(blueprintContext({ departments: [ems] }));
    const plan = await planOnce(guild, store, next);
    const creates = plan.items.filter((item) => item.kind === 'CREATE').map((item) => item.key);
    expect(creates).toEqual(
      expect.arrayContaining([
        'role.dept.ems.member',
        'role.dept.ems.command',
        'category.dept.ems',
        'channel.dept.ems.announcements',
        'channel.dept.ems.general',
        'voice.dept.ems.operations',
      ]),
    );
    await executeOnce(guild, store, next);
    const after = await planOnce(guild, store, next);
    expect(after.liveAudit.passed).toBe(true);
    expect(after.counts.create).toBe(0);
  });

  it('archives an organisation without deleting its history', async () => {
    const org: OrganizationInput = {
      key: 'vagos',
      name: 'Vagos',
      kind: 'STREET_GANG',
      staffVisible: true,
      publicMembership: false,
      archived: false,
    };
    const { guild, store } = await provisioned(
      buildDesiredState(blueprintContext({ organizations: [org] })),
    );
    const general = [...guild.channels.values()].find(
      (channel) =>
        channel.name === 'general' &&
        channel.parentId !== null &&
        guild.channels.get(channel.parentId)?.name === 'Vagos',
    );
    expect(general).toBeDefined();

    const archived = buildDesiredState(
      blueprintContext({ organizations: [{ ...org, archived: true }] }),
    );
    guild.calls.length = 0;
    await executeOnce(guild, store, archived);

    expect(guild.calls.some((call) => call.startsWith('delete'))).toBe(false);
    expect(guild.channels.has(general?.id ?? '')).toBe(true);
    const after = await planOnce(guild, store, archived);
    expect(after.liveAudit.passed).toBe(true);
    const category = [...guild.channels.values()].find((channel) =>
      channel.name.startsWith('🗄️ Archived'),
    );
    expect(category?.overwrites.find((o) => o.id === guild.id)?.deny ?? 0n).toBe(
      P.ViewChannel | P.Connect,
    );
  });
});

describe('cleanup of a failed run', () => {
  it('removes only what that run created, keeps history, and needs force for roles', async () => {
    const guild = new FakeGuild();
    const store = memoryRegistry();
    const state = buildDesiredState(blueprintContext());
    const existing = guild.addChannel({
      name: 'old-chat',
      kind: 'text',
      parentId: null,
      topic: null,
    });
    await executeOnce(guild, store, state, { runId: 'failed-run' });

    const general = guild.channelByName('general');
    if (general === undefined) throw new Error('missing');
    general.humanHistory = true;

    const outcome = await cleanupRun('failed-run', guild, store, { force: false });
    expect(guild.channels.has(existing)).toBe(true);
    expect(guild.channels.has(general.id)).toBe(true);
    expect(outcome.kept.map((entry) => entry.key)).toEqual(
      expect.arrayContaining(['channel.general', 'role.whitelisted']),
    );
    expect(guild.roleByName('Whitelisted')).toBeDefined();
    expect(guild.channelByName('rules')).toBeUndefined();

    const other = await cleanupRun('another-run', guild, store, { force: true });
    expect(other.deleted).toEqual([]);
  });
});
