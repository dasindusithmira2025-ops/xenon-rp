import { beforeEach, describe, expect, it } from 'vitest';

import { ForbiddenError, ValidationError } from '@xenon/core';
import {
  adoptExistingResources,
  buildDesiredState,
  createRun,
  loadOrganizationSpaces,
  PROVISION_PHRASE,
  prismaRegistry,
  resolveConflict,
  saveIntegration,
  saveOrganizationSpace,
} from '@xenon/discord/provisioning';
import { blueprintContext, executeOnce, FakeGuild, planOnce } from '@xenon/discord/testing';

import { createActor, prisma, resetDatabase } from './harness';

/**
 * Provisioning against a real database and a fake guild.
 *
 * The registry, run table, conflict decisions and integration write-back are
 * exercised through Postgres; Discord is the in-memory adapter, so nothing
 * here can reach a real server.
 */

beforeEach(async () => {
  await resetDatabase();
});

async function owner() {
  return (await createActor({ roleKeys: ['owner'] })).actor;
}

async function completedPlan(guildId: string, profile = 'EMPTY', completedAt = new Date()) {
  return prisma.discordProvisionRun.create({
    data: {
      guildId,
      mode: 'PLAN',
      status: 'SUCCEEDED',
      source: 'WEB',
      actorLabel: 'test',
      blueprintVersion: 'discord-blueprint-v1',
      plannedChanges: { profile, signature: [], items: [] },
      completedAt,
    },
  });
}

describe('registry persistence', () => {
  it('survives a restart: a second run against the stored registry changes nothing', async () => {
    const guild = new FakeGuild();
    const state = buildDesiredState(blueprintContext());

    const first = await executeOnce(guild, prismaRegistry(prisma, guild.id), state);
    expect(first.result.failed).toEqual([]);
    expect(
      await prisma.discordManagedResource.count({ where: { guildId: guild.id } }),
    ).toBeGreaterThan(40);

    // A fresh store instance reads only what Postgres holds.
    const replan = await planOnce(guild, prismaRegistry(prisma, guild.id), state);
    expect(replan.counts.create + replan.counts.update + replan.counts.drift).toBe(0);
    expect(replan.liveAudit.passed).toBe(true);
  });
});

describe('run safety', () => {
  it('refuses exact resource adoption without bootstrap permission', async () => {
    const { actor } = await createActor({ roleKeys: ['administrator'] });
    await expect(
      adoptExistingResources(prisma, actor, {
        guildId: 'guild-id',
        guildName: 'Existing server',
        state: buildDesiredState(blueprintContext()),
        channels: [],
        roles: [],
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses provisioning to anyone without the bootstrap capability', async () => {
    const { actor } = await createActor({ roleKeys: ['administrator'] });
    await expect(createRun(prisma, actor, { guildId: 'g', mode: 'PLAN' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('requires the typed phrase and a reviewed plan before applying', async () => {
    const actor = await owner();
    const plan = await completedPlan('g');
    await expect(
      createRun(prisma, actor, { guildId: 'g', mode: 'APPLY', basedOnRunId: plan.id }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createRun(prisma, actor, { guildId: 'g', mode: 'APPLY', confirmation: PROVISION_PHRASE }),
    ).rejects.toBeInstanceOf(ValidationError);
    const run = await createRun(prisma, actor, {
      guildId: 'g',
      mode: 'APPLY',
      basedOnRunId: plan.id,
      confirmation: PROVISION_PHRASE,
    });
    expect(run.status).toBe('QUEUED');
    expect(
      await prisma.auditLog.count({ where: { action: 'DISCORD_SETUP_APPLY_REQUESTED' } }),
    ).toBe(1);
  });

  it('refuses a stale plan and a second concurrent apply', async () => {
    const actor = await owner();
    const stale = await completedPlan('g', 'EMPTY', new Date(Date.now() - 60 * 60_000));
    await expect(
      createRun(prisma, actor, {
        guildId: 'g',
        mode: 'APPLY',
        basedOnRunId: stale.id,
        confirmation: PROVISION_PHRASE,
      }),
    ).rejects.toThrow(/expired/);

    const fresh = await completedPlan('g');
    await createRun(prisma, actor, {
      guildId: 'g',
      mode: 'APPLY',
      basedOnRunId: fresh.id,
      confirmation: PROVISION_PHRASE,
    });
    await expect(
      createRun(prisma, actor, {
        guildId: 'g',
        mode: 'APPLY',
        basedOnRunId: fresh.id,
        confirmation: PROVISION_PHRASE,
      }),
    ).rejects.toThrow(/in progress/);
  });

  it('defaults an established server to plan-only until acknowledged', async () => {
    const actor = await owner();
    const plan = await completedPlan('g', 'ESTABLISHED');
    await expect(
      createRun(prisma, actor, {
        guildId: 'g',
        mode: 'APPLY',
        basedOnRunId: plan.id,
        confirmation: PROVISION_PHRASE,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    const run = await createRun(prisma, actor, {
      guildId: 'g',
      mode: 'APPLY',
      basedOnRunId: plan.id,
      confirmation: PROVISION_PHRASE,
      acknowledgeEstablished: true,
    });
    expect(run.status).toBe('QUEUED');
  });

  it('keeps cleanup behind the destructive capability', async () => {
    const { actor } = await createActor({ roleKeys: ['administrator'] });
    await expect(
      createRun(prisma, actor, {
        guildId: 'g',
        mode: 'CLEANUP',
        basedOnRunId: 'x',
        confirmation: 'DELETE XENON RESOURCES',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('conflicts and integration', () => {
  it('adopts existing channels and staff roles, writes integrations, preserves role choices and audits', async () => {
    const actor = await owner();
    const state = buildDesiredState(blueprintContext());
    const guildId = '100000000000000000';
    const channels = [
      { id: 'existing-announcements', name: 'announcements', kind: 'text' as const },
      { id: 'existing-welcome', name: 'welcome', kind: 'text' as const },
      { id: 'existing-rules', name: 'rules', kind: 'text' as const },
      { id: 'existing-review', name: 'whitelist-review', kind: 'text' as const },
      { id: 'existing-logs', name: 'bot-logs', kind: 'text' as const },
    ];
    const roles = [
      { id: 'existing-management', name: 'Management', managed: false },
      { id: 'existing-admin', name: 'Administrator', managed: false },
      { id: 'existing-moderator', name: 'Moderator', managed: false },
      { id: 'existing-whitelist', name: 'Whitelist Team', managed: false },
    ];
    const operatorRole = await prisma.role.findUniqueOrThrow({ where: { key: 'administrator' } });
    const discordGuild = await prisma.discordGuild.create({
      data: { guildId, name: 'Existing production server', isPrimary: true },
    });
    await prisma.discordRoleMapping.create({
      data: {
        guildId: discordGuild.id,
        roleId: operatorRole.id,
        discordRoleId: 'operator-selected-admin-role',
      },
    });

    const result = await adoptExistingResources(prisma, actor, {
      guildId,
      guildName: 'Existing production server',
      state,
      channels,
      roles,
    });

    expect(result.adopted.map((entry) => entry.logicalKey)).toEqual(
      expect.arrayContaining([
        'channel.announcements',
        'channel.welcome',
        'channel.rules',
        'channel.whitelist-review',
        'channel.bot-ops',
        'role.staff.management',
        'role.staff.admin',
        'role.staff.moderator',
        'role.staff.whitelist',
      ]),
    );
    expect(result.roleMappingsSkipped).toBe(1);
    const announcements = await prisma.discordManagedResource.findUniqueOrThrow({
      where: { guildId_logicalKey: { guildId, logicalKey: 'channel.announcements' } },
    });
    expect(announcements.discordResourceId).toBe('existing-announcements');
    expect(announcements.managed).toBe(true);
    expect(announcements.createdByRunId).toBeNull();
    expect(announcements.metadata).toMatchObject({ adopted: true, adoptedFrom: 'announcements' });

    const integration = await prisma.discordGuild.findUniqueOrThrow({ where: { guildId } });
    expect(integration.announcementChannelId).toBe('existing-announcements');
    expect(integration.reviewChannelId).toBe('existing-review');
    expect(integration.logChannelId).toBe('existing-logs');
    const mappings = await prisma.discordRoleMapping.findMany({
      where: { guildId: discordGuild.id },
    });
    expect(mappings.find((mapping) => mapping.roleId === operatorRole.id)?.discordRoleId).toBe(
      'operator-selected-admin-role',
    );
    const moderator = await prisma.role.findUniqueOrThrow({ where: { key: 'moderator' } });
    expect(mappings.find((mapping) => mapping.roleId === moderator.id)?.discordRoleId).toBe(
      'existing-moderator',
    );
    expect(await prisma.discordProvisionRun.count({ where: { guildId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'DISCORD_RESOURCE_ADOPTED' } })).toBe(
      result.adopted.length,
    );
  });

  it('adopts an unmanaged channel on an operator decision, and apply updates it in place', async () => {
    const actor = await owner();
    const guild = new FakeGuild();
    const existing = guild.addChannel({ name: 'rules', kind: 'text', parentId: null, topic: null });
    const state = buildDesiredState(blueprintContext());
    const store = prismaRegistry(prisma, guild.id);
    const plan = await planOnce(guild, store, state);

    const run = await prisma.discordProvisionRun.create({
      data: {
        guildId: guild.id,
        mode: 'PLAN',
        status: 'SUCCEEDED',
        source: 'WEB',
        actorLabel: 'test',
        blueprintVersion: state.version,
        plannedChanges: JSON.parse(JSON.stringify({ items: plan.items })) as object,
        completedAt: new Date(),
      },
    });
    await resolveConflict(prisma, actor, {
      guildId: guild.id,
      planRunId: run.id,
      key: 'channel.rules',
      resolution: 'ADOPT',
    });
    expect(await prisma.auditLog.count({ where: { action: 'DISCORD_RESOURCE_ADOPTED' } })).toBe(1);

    await executeOnce(guild, store, state);
    expect([...guild.channels.values()].filter((channel) => channel.name === 'rules')).toHaveLength(
      1,
    );
    expect(guild.channels.get(existing)?.parentId).not.toBeNull();
  });

  it('points review cards at the provisioned channel and maps roles without overriding operators', async () => {
    const actor = await owner();
    const moderator = await prisma.role.findUniqueOrThrow({ where: { key: 'moderator' } });
    const guildRow = await prisma.discordGuild.create({
      data: { guildId: '100000000000000000', name: 'Dev', isPrimary: true },
    });
    await prisma.discordRoleMapping.create({
      data: { guildId: guildRow.id, roleId: moderator.id, discordRoleId: 'operator-choice' },
    });

    const outcome = await saveIntegration(prisma, actor, {
      guildId: '100000000000000000',
      guildName: 'Dev',
      channels: { reviewChannel: 'review-1', logChannel: 'log-1' },
      roleMappings: [
        {
          xenonRoleKey: 'moderator',
          discordRoleId: 'xenon-moderator',
          discordRoleName: 'Moderator',
        },
        {
          xenonRoleKey: 'administrator',
          discordRoleId: 'xenon-admin',
          discordRoleName: 'Administrator',
        },
      ],
    });

    expect(outcome).toEqual({ mapped: 1, skipped: 1 });
    const guild = await prisma.discordGuild.findUniqueOrThrow({
      where: { id: guildRow.id },
      include: { roleMappings: true },
    });
    expect(guild.reviewChannelId).toBe('review-1');
    expect(guild.roleMappings.find((m) => m.roleId === moderator.id)?.discordRoleId).toBe(
      'operator-choice',
    );
  });

  it('records organisation spaces and archives them without deleting anything', async () => {
    const actor = await owner();
    await saveOrganizationSpace(prisma, actor, 'g', {
      key: 'vagos',
      name: 'Vagos',
      kind: 'STREET_GANG',
    });
    await saveOrganizationSpace(prisma, actor, 'g', {
      key: 'vagos',
      name: 'Vagos',
      kind: 'STREET_GANG',
      archived: true,
    });
    const spaces = await loadOrganizationSpaces(prisma, 'g');
    expect(spaces).toEqual([
      expect.objectContaining({ key: 'vagos', archived: true, publicMembership: false }),
    ]);
    expect(await prisma.auditLog.count({ where: { action: 'DISCORD_SPACE_ARCHIVED' } })).toBe(1);
  });
});
