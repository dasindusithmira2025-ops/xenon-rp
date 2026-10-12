import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AutoModerationRuleTriggerType,
  ChannelType,
  Collection,
  DiscordAPIError,
  MessageFlags,
  PermissionsBitField,
  PermissionFlagsBits as P,
  type ChatInputCommandInteraction,
  type Guild,
} from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { JsonDiscordRuntimeStore } from '../runtime-store';

import {
  computePostureLabel,
  handleModerationCommand,
  handleSecurityCommand,
  renderScan,
  SECURITY_COMMANDS,
} from './commands';
import { createCase, type PermissionFinding, type TrustLevel } from './model';

import type { SecurityService } from './service';

const guildId = '12345678901234567';
const ownerId = '22345678901234567';
const moderatorId = '32345678901234567';
const targetId = '42345678901234567';

const SCAN_TEST_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;

function scanTestFindings(count: number): PermissionFinding[] {
  return Array.from({ length: count }, (_, index) => ({
    severity: SCAN_TEST_SEVERITIES[index % SCAN_TEST_SEVERITIES.length]!,
    code: `SCAN_TEST_${String(index).padStart(3, '0')}`,
    subject: `ticket-🎟️-${'界'.repeat(35)}-${String(index)}`,
    detail: `Permission detail ${String(index)} 🔐 ${'🔐'.repeat(index === 34 ? 2_500 : 3)}`,
    remediation: `Review ticket access ${String(index)} and retain only required permissions →`,
  }));
}

function makeInteraction(
  commandName: string,
  userId: string,
  options: {
    readonly getSubcommandGroup?: () => string | null;
    readonly getSubcommand?: () => string;
    readonly getUser?: (name: string) => { readonly id: string } | null;
    readonly getString?: (name: string) => string | null;
  },
): ChatInputCommandInteraction {
  return {
    commandName,
    user: { id: userId },
    options,
    memberPermissions: new PermissionsBitField(P.ManageGuild | P.ManageMessages),
    deferred: true,
    replied: false,
    deferReply: vi.fn(() => Promise.resolve(undefined)),
    editReply: vi.fn(() => Promise.resolve(undefined)),
    reply: vi.fn(() => Promise.resolve(undefined)),
  } as unknown as ChatInputCommandInteraction;
}

describe('security command authorization', () => {
  let directory = '';

  afterEach(async () => {
    if (directory !== '') await rm(directory, { recursive: true, force: true });
    directory = '';
  });

  it('rejects a moderation target at the same highest role as the human moderator', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-moderation-hierarchy-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    await store.updateGuild(guildId, (current) => ({
      ...current,
      security: {
        ...current.security,
        config: {
          ...current.security.config,
          trustedActors: {
            ...current.security.config.trustedActors,
            [moderatorId]: 'NORMAL_STAFF',
          },
        },
      },
    }));
    const moderator = {
      roles: { highest: { comparePositionTo: () => 0 } },
    };
    const target = {
      id: targetId,
      manageable: true,
      roles: { highest: { position: 4 } },
      send: vi.fn(() => Promise.resolve(undefined)),
    };
    const guild = {
      id: guildId,
      name: 'XenonRP',
      ownerId,
      members: {
        fetch: vi.fn((input: string | { readonly user: string }) => {
          const id = typeof input === 'string' ? input : input.user;
          return Promise.resolve(id === moderatorId ? moderator : target);
        }),
      },
    } as unknown as Guild;
    const interaction = makeInteraction('warn', moderatorId, {
      getUser: () => ({ id: targetId }),
      getString: () => 'Test warning',
    });

    await handleModerationCommand(interaction, guild, store, fakeService({}));

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'Your highest role must strictly outrank the target member.',
      embeds: [],
    });
    expect(target.send).not.toHaveBeenCalled();
  });

  it('rechecks both trust records inside the serialized mutation after snapshot work', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-trust-race-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    await store.updateGuild(guildId, (current) => ({
      ...current,
      security: {
        ...current.security,
        config: {
          ...current.security.config,
          trustedActors: {
            ...current.security.config.trustedActors,
            [moderatorId]: 'SECURITY_ADMIN',
            [targetId]: 'NORMAL_STAFF',
          },
        },
      },
    }));
    const guild = { id: guildId, ownerId } as Guild;
    const service = fakeService({
      saveSnapshot: async () => {
        await store.updateGuild(guildId, (current) => ({
          ...current,
          security: {
            ...current.security,
            config: {
              ...current.security.config,
              trustedActors: {
                ...current.security.config.trustedActors,
                [targetId]: 'SECURITY_ADMIN',
              },
            },
          },
        }));
        return undefined;
      },
    });
    const interaction = makeInteraction('security', moderatorId, {
      getSubcommandGroup: () => 'trust',
      getSubcommand: () => 'add',
      getUser: () => ({ id: targetId }),
      getString: () => 'TRUSTED_STAFF',
    });

    await handleSecurityCommand(interaction, guild, store, service);

    expect((await store.getGuild(guildId)).security.config.trustedActors[targetId]).toBe(
      'SECURITY_ADMIN',
    );
    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        'Trust was not changed: only the owner or a security admin may change trust; the owner alone may change SECURITY_ADMIN trust.',
      embeds: [],
    });
  });
});

interface FakeOptions {
  readonly group?: string | null;
  readonly subcommand?: string;
  readonly user?: string;
  readonly strings?: Readonly<Record<string, string>>;
  readonly integers?: Readonly<Record<string, number>>;
  readonly booleans?: Readonly<Record<string, boolean | null>>;
}

function fakeInteraction(
  commandName: string,
  userId: string,
  permissions: bigint,
  options: FakeOptions = {},
): ChatInputCommandInteraction {
  return {
    commandName,
    user: { id: userId },
    options: {
      getSubcommandGroup: () => options.group ?? null,
      getSubcommand: () => options.subcommand ?? '',
      getUser: () => (options.user === undefined ? null : { id: options.user }),
      getString: (name: string) => options.strings?.[name] ?? null,
      getInteger: (name: string) => options.integers?.[name] ?? null,
      getBoolean: (name: string) => options.booleans?.[name] ?? null,
    },
    memberPermissions: new PermissionsBitField(permissions),
    deferred: true,
    replied: false,
    deferReply: vi.fn(() => Promise.resolve(undefined)),
    editReply: vi.fn(() => Promise.resolve(undefined)),
    followUp: vi.fn(() => Promise.resolve(undefined)),
    reply: vi.fn(() => Promise.resolve(undefined)),
  } as unknown as ChatInputCommandInteraction;
}

function fakeService(partial: object): SecurityService {
  return {
    runManual: (_actorId: string, operation: () => Promise<unknown>) => operation(),
    ...partial,
  } as unknown as SecurityService;
}

function lastReply(interaction: ChatInputCommandInteraction): string {
  const calls = vi.mocked(interaction.editReply).mock.calls;
  const last = calls.at(-1)?.[0];
  return typeof last === 'object' && 'content' in last ? (last.content ?? '') : '';
}

describe('computePostureLabel', () => {
  const base = {
    lockdownActive: false,
    enabled: true,
    findings: [],
    incidents: [],
    raidLevel: 'NORMAL' as const,
    degraded: false,
    enforcementMode: 'ENFORCE' as const,
  };

  it('applies the documented precedence', () => {
    const critical = [{ severity: 'CRITICAL' as const }];
    expect(computePostureLabel(base)).toBe('PROTECTED');
    expect(computePostureLabel({ ...base, degraded: true })).toBe('DEGRADED');
    expect(computePostureLabel({ ...base, degraded: true, findings: critical })).toBe('AT RISK');
    expect(computePostureLabel({ ...base, findings: critical, enabled: false })).toBe('DISABLED');
    expect(
      computePostureLabel({ ...base, findings: critical, enabled: false, lockdownActive: true }),
    ).toBe('LOCKDOWN');
  });

  it('reports DEGRADED when automatic protection is inactive, below LOCKDOWN and AT RISK', () => {
    const critical = [{ severity: 'CRITICAL' as const }];
    for (const enforcementMode of ['OBSERVE', 'ALERT'] as const) {
      const input = { ...base, enforcementMode };
      expect(computePostureLabel(input)).toBe('DEGRADED');
      expect(computePostureLabel({ ...input, findings: critical })).toBe('AT RISK');
      expect(computePostureLabel({ ...input, lockdownActive: true })).toBe('LOCKDOWN');
      expect(computePostureLabel({ ...input, enabled: false })).toBe('DISABLED');
    }
  });

  it('treats open high/critical incidents and raid levels as at risk, but not handled ones', () => {
    const open = (severity: 'HIGH' | 'MEDIUM', status: 'OPEN' | 'RESOLVED') => ({
      severity,
      status,
    });
    expect(computePostureLabel({ ...base, incidents: [open('HIGH', 'OPEN')] })).toBe('AT RISK');
    expect(computePostureLabel({ ...base, incidents: [open('HIGH', 'RESOLVED')] })).toBe(
      'PROTECTED',
    );
    expect(computePostureLabel({ ...base, incidents: [open('MEDIUM', 'OPEN')] })).toBe('PROTECTED');
    expect(computePostureLabel({ ...base, raidLevel: 'RAID' })).toBe('AT RISK');
    expect(computePostureLabel({ ...base, raidLevel: 'CRITICAL' })).toBe('AT RISK');
    expect(computePostureLabel({ ...base, raidLevel: 'WARNING' })).toBe('PROTECTED');
  });
});

describe('security scan report rendering', () => {
  it.each([35, 100, 200])(
    'preserves every finding and respects Discord limits for %i findings',
    (count) => {
      const findings = scanTestFindings(count);
      const pages = renderScan(findings);
      const reportText = pages
        .flatMap((page) => page.embeds.map((embed) => embed.toJSON().description ?? ''))
        .join('');

      expect(pages.length).toBeGreaterThan(1);
      for (const finding of findings) {
        expect(reportText.split(finding.code)).toHaveLength(2);
        expect(reportText).toContain(`Subject: ${finding.subject}`);
        expect(reportText).toContain(`Description: ${finding.detail}`);
        expect(reportText).toContain(`Remediation: ${finding.remediation}`);
      }
      const expectedCounts = SCAN_TEST_SEVERITIES.map(
        (severity) =>
          `${severity} ${String(findings.filter((finding) => finding.severity === severity).length)}`,
      ).join(' · ');
      for (const page of pages) {
        expect(page.content.length).toBeLessThanOrEqual(2_000);
        expect(page.embeds.length).toBeLessThanOrEqual(10);
        const embeds = page.embeds.map((embed) => embed.toJSON());
        let totalEmbedCharacters = 0;
        for (const embed of embeds) {
          expect(embed.title?.length ?? 0).toBeLessThanOrEqual(256);
          expect(embed.description?.length ?? 0).toBeLessThanOrEqual(4_096);
          totalEmbedCharacters +=
            (embed.title?.length ?? 0) +
            (embed.description?.length ?? 0) +
            (embed.author?.name.length ?? 0) +
            (embed.footer?.text.length ?? 0) +
            (embed.fields?.reduce(
              (total, field) => total + field.name.length + field.value.length,
              0,
            ) ?? 0);
        }
        expect(totalEmbedCharacters).toBeLessThanOrEqual(6_000);
        expect(page.content).toContain('CRITICAL');
        expect(page.content).toContain('HIGH');
        expect(page.content).toContain('MEDIUM');
        expect(page.content).toContain('LOW');
        expect(page.content).toContain('INFO');
        expect(page.content).toContain(expectedCounts);
      }
    },
  );
});

describe('security and moderation command behavior', () => {
  let directory = '';

  afterEach(async () => {
    if (directory !== '') await rm(directory, { recursive: true, force: true });
    directory = '';
  });

  async function makeStore(): Promise<JsonDiscordRuntimeStore> {
    directory = await mkdtemp(join(tmpdir(), 'xenon-commands-'));
    return new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
  }

  function moderationGuild(botPermissions: bigint, overrides: Record<string, unknown> = {}) {
    const target = {
      id: targetId,
      manageable: true,
      moderatable: true,
      roles: { highest: { position: 1 } },
      kick: vi.fn(() => Promise.resolve(undefined)),
    };
    const members = {
      me: { permissions: new PermissionsBitField(botPermissions) },
      fetch: vi.fn(() => Promise.resolve(target)),
      ban: vi.fn(() => Promise.resolve(undefined)),
      unban: vi.fn(() => Promise.resolve(undefined)),
    };
    const bans = { fetch: vi.fn(() => Promise.reject(new Error('not banned'))) };
    const guild = {
      id: guildId,
      name: 'XenonRP',
      ownerId,
      members,
      bans,
      channels: { cache: new Collection() },
      ...overrides,
    } as unknown as Guild;
    return { guild, target, members, bans };
  }

  const kickInteraction = () =>
    fakeInteraction('kick', ownerId, P.KickMembers, {
      user: targetId,
      strings: { reason: 'Rule break' },
    });

  it('sends subsequent scan pages as ephemeral follow-ups', async () => {
    const store = await makeStore();
    const { guild } = moderationGuild(P.ManageGuild);
    const findings = scanTestFindings(100);
    const interaction = fakeInteraction('security', ownerId, P.ManageGuild, {
      subcommand: 'scan',
    });

    await handleSecurityCommand(
      interaction,
      guild,
      store,
      fakeService({ scanPermissions: vi.fn(() => Promise.resolve(findings)) }),
    );

    expect(vi.mocked(interaction.editReply)).toHaveBeenCalledOnce();
    expect(vi.mocked(interaction.followUp).mock.calls.length).toBeGreaterThan(0);
    for (const [payload] of vi.mocked(interaction.followUp).mock.calls)
      expect(payload).toEqual(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
  });

  it('does not save a case when Discord rejects the kick, and exposes only the API code', async () => {
    const store = await makeStore();
    const { guild, target } = moderationGuild(P.KickMembers);
    target.kick.mockRejectedValue(
      new DiscordAPIError(
        { code: 50013, message: 'Missing Permissions for token abc' },
        50013,
        403,
        'PUT',
        'url',
        {},
      ),
    );
    const saveCase = vi.fn();
    const interaction = kickInteraction();

    await handleModerationCommand(
      interaction,
      guild,
      store,
      fakeService({
        saveCase,
      }),
    );

    expect(saveCase).not.toHaveBeenCalled();
    expect(lastReply(interaction)).toContain('50013');
    expect(lastReply(interaction)).not.toContain('token abc');
  });

  it('rejects the action without a case when the bot lacks the permission', async () => {
    const store = await makeStore();
    const { guild, target } = moderationGuild(0n);
    const saveCase = vi.fn();
    const interaction = kickInteraction();

    await handleModerationCommand(
      interaction,
      guild,
      store,
      fakeService({
        saveCase,
      }),
    );

    expect(target.kick).not.toHaveBeenCalled();
    expect(saveCase).not.toHaveBeenCalled();
    expect(lastReply(interaction)).toContain('Kick Members');
  });

  it('rejects banning a user who is already banned', async () => {
    const store = await makeStore();
    const { guild, members, bans } = moderationGuild(P.BanMembers);
    bans.fetch.mockResolvedValue(undefined as never);
    const saveCase = vi.fn();
    const interaction = fakeInteraction('ban', ownerId, P.BanMembers, {
      user: targetId,
      strings: { reason: 'Spam' },
    });

    await handleModerationCommand(
      interaction,
      guild,
      store,
      fakeService({
        saveCase,
      }),
    );

    expect(members.ban).not.toHaveBeenCalled();
    expect(saveCase).not.toHaveBeenCalled();
    expect(lastReply(interaction)).toContain('already banned');
  });

  it('rejects unbanning a user who is not banned', async () => {
    const store = await makeStore();
    const { guild, members, bans } = moderationGuild(P.BanMembers);
    bans.fetch.mockRejectedValue(
      new DiscordAPIError({ code: 10026, message: 'Unknown Ban' }, 10026, 404, 'GET', 'url', {}),
    );
    const interaction = fakeInteraction('unban', ownerId, P.BanMembers, {
      strings: { reason: 'Appeal', user_id: targetId },
    });

    await handleModerationCommand(
      interaction,
      guild,
      store,
      fakeService({
        saveCase: vi.fn(),
      }),
    );

    expect(members.unban).not.toHaveBeenCalled();
    expect(lastReply(interaction)).toContain('not banned');
  });

  it('rejects a duplicate of a case recorded within the last 15 seconds', async () => {
    const store = await makeStore();
    await store.updateGuild(guildId, (current) => ({
      ...current,
      security: {
        ...current.security,
        cases: [
          createCase({
            action: 'KICK',
            moderatorId: ownerId,
            targetId,
            reason: 'first',
            durationSeconds: null,
            evidenceReference: null,
          }),
        ],
      },
    }));
    const { guild, target } = moderationGuild(P.KickMembers);
    const interaction = kickInteraction();

    await handleModerationCommand(
      interaction,
      guild,
      store,
      fakeService({
        saveCase: vi.fn(),
      }),
    );

    expect(target.kick).not.toHaveBeenCalled();
    expect(lastReply(interaction)).toContain('no duplicate');
  });

  it('performs an identical concurrent action only once', async () => {
    const store = await makeStore();
    const { guild, target } = moderationGuild(P.KickMembers);
    let release: () => void = () => undefined;
    target.kick.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => {
            resolve(undefined);
          };
        }),
    );
    const service = fakeService({
      saveCase: vi.fn(() => Promise.resolve(undefined)),
    });
    const first = kickInteraction();
    const running = handleModerationCommand(first, guild, store, service);
    await vi.waitFor(() => {
      expect(target.kick).toHaveBeenCalledTimes(1);
    });
    const second = kickInteraction();

    await handleModerationCommand(second, guild, store, service);
    release();
    await running;

    expect(target.kick).toHaveBeenCalledTimes(1);
    expect(lastReply(second)).toContain('no duplicate');
    expect(lastReply(first)).toContain('Completed kick');
  });

  it('rejects /security for a user with Discord permission but no Xenon trust', async () => {
    const store = await makeStore();
    const guild = { id: guildId, ownerId } as Guild;
    const service = fakeService({ saveSnapshot: vi.fn() });
    const interaction = fakeInteraction('security', moderatorId, P.ManageGuild, {
      subcommand: 'setup',
    });

    await handleSecurityCommand(interaction, guild, store, service);

    expect(lastReply(interaction)).toContain('Not authorized');
    expect(service.saveSnapshot).not.toHaveBeenCalled();
  });

  it('handles an unknown subcommand without throwing', async () => {
    const store = await makeStore();
    const guild = { id: guildId, ownerId } as Guild;
    const interaction = fakeInteraction('security', ownerId, P.ManageGuild, {
      subcommand: 'bogus',
    });

    await handleSecurityCommand(interaction, guild, store, fakeService({}));

    expect(lastReply(interaction)).toBe('Unsupported security command.');
  });

  it('persists optional raid recovery and slowmode settings and keeps unset ones', async () => {
    const store = await makeStore();
    const guild = { id: guildId, ownerId } as Guild;
    const service = fakeService({
      saveSnapshot: vi.fn(() => Promise.resolve(undefined)),
    });
    const thresholds = {
      warning10s: 3,
      raid10s: 6,
      critical10s: 12,
      warning30s: 5,
      raid30s: 10,
      critical30s: 20,
    };
    const run = (extra: Record<string, number>) =>
      handleSecurityCommand(
        fakeInteraction('security', ownerId, P.ManageGuild, {
          group: 'config',
          subcommand: 'raid-thresholds',
          integers: { ...thresholds, ...extra },
        }),
        guild,
        store,
        service,
      );

    await run({ recovery_minutes: 45, slowmode_seconds: 0 });
    await run({ recovery_minutes: 60 });

    const config = (await store.getGuild(guildId)).security.config;
    expect(config.raidRecoveryMinutes).toBe(60);
    expect(config.raidSlowmodeSeconds).toBe(0);
    expect(config.raidThresholds.raid10s).toBe(6);
  });

  it('releases raid response after switching raid mode off and reports it', async () => {
    const store = await makeStore();
    const guild = { id: guildId, ownerId } as Guild;
    const service = fakeService({
      saveSnapshot: vi.fn(() => Promise.resolve(undefined)),
      recordManualRaidMode: vi.fn(() => Promise.resolve(undefined)),
      checkRaidRecovery: vi.fn(() => Promise.resolve(true)),
    });
    const interaction = fakeInteraction('security', ownerId, P.ManageGuild, {
      group: 'raid-mode',
      subcommand: 'off',
    });

    await handleSecurityCommand(interaction, guild, store, service);

    expect(service.checkRaidRecovery).toHaveBeenCalledOnce();
    expect((await store.getGuild(guildId)).security.config.raidMode).toBe('OFF');
    expect(lastReply(interaction)).toContain('released');
  });

  it('reports created, skipped, conflicting, and existing server AutoMod rules', async () => {
    const store = await makeStore();
    const { guild } = moderationGuild(P.ManageGuild);
    const interaction = fakeInteraction('security', ownerId, P.ManageGuild, {
      group: 'automod',
      subcommand: 'sync',
    });
    const service = fakeService({
      syncAutoMod: vi.fn(() =>
        Promise.resolve({
          created: ['XENON | Invite Protection'],
          updated: ['XENON | Security Keywords'],
          skipped: ['XENON | Mention Spam: trigger limit reached'],
          conflicts: ['Server Mention Guard was left untouched'],
          xenonOwnedRuleCount: 2,
          existingServerRules: [
            {
              name: 'Server Mention Guard',
              triggerType: AutoModerationRuleTriggerType.MentionSpam,
              enabled: true,
            },
          ],
          unavailable: null,
        }),
      ),
    });

    await handleSecurityCommand(interaction, guild, store, service);

    const response = lastReply(interaction);
    expect(response).toContain('Created: XENON | Invite Protection');
    expect(response).toContain('Updated: XENON | Security Keywords');
    expect(response).toContain('Skipped: XENON | Mention Spam');
    expect(response).toContain('Conflicts: Server Mention Guard');
    expect(response).toContain('Xenon-owned rules after sync: 2');
    expect(response).toContain('Existing server-wide rules before sync (not Xenon-owned)');
  });

  it('distinguishes existing server-wide rules from Xenon-owned AutoMod rules in status', async () => {
    const store = await makeStore();
    const externalRule = {
      id: '80000000000000001',
      name: 'Server Mention Guard',
      triggerType: AutoModerationRuleTriggerType.MentionSpam,
      enabled: true,
    };
    const rules = new Collection([[externalRule.id, externalRule]]);
    const { guild } = moderationGuild(P.ManageGuild, {
      autoModerationRules: { fetch: vi.fn(() => Promise.resolve(rules)) },
    });
    const interaction = fakeInteraction('security', ownerId, P.ManageGuild, {
      group: 'automod',
      subcommand: 'status',
    });

    await handleSecurityCommand(interaction, guild, store, fakeService({}));

    expect(lastReply(interaction)).toContain('Xenon-owned rules: 0 current / 0 tracked');
    expect(lastReply(interaction)).toContain('Existing non-Xenon server rules: 1 total, 1 enabled');
    expect(lastReply(interaction)).toContain(externalRule.name);
  });

  it('creates nothing on repeated setup when the guild is already configured', async () => {
    const store = await makeStore();
    const channelOf = (id: string, name: string) => ({
      id,
      name,
      type: ChannelType.GuildText,
      parent: null,
    });
    const channels = new Collection<string, unknown>([
      ['70000000000000001', channelOf('70000000000000001', 'security-alerts')],
      ['70000000000000002', channelOf('70000000000000002', 'security-audit')],
      ['70000000000000003', channelOf('70000000000000003', 'mod-logs')],
    ]);
    const roles = new Collection<string, unknown>([
      [
        '80000000000000001',
        {
          id: '80000000000000001',
          name: 'Xenon Quarantine',
          managed: false,
          permissions: { bitfield: 0n },
        },
      ],
    ]);
    const create = vi.fn();
    const roleCreate = vi.fn();
    const guild = {
      id: guildId,
      ownerId,
      channels: { cache: channels, create },
      roles: { cache: roles, create: roleCreate },
    } as unknown as Guild;
    const service = fakeService({
      saveSnapshot: vi.fn(() => Promise.resolve(undefined)),
      syncAutoMod: vi.fn(() =>
        Promise.resolve({
          created: [],
          updated: [],
          skipped: [],
          conflicts: [],
          xenonOwnedRuleCount: 0,
          existingServerRules: [],
          unavailable: null,
        }),
      ),
    });

    for (let run = 0; run < 2; run += 1) {
      await handleSecurityCommand(
        fakeInteraction('security', ownerId, P.ManageGuild, { subcommand: 'setup' }),
        guild,
        store,
        service,
      );
    }

    expect(create).not.toHaveBeenCalled();
    expect(roleCreate).not.toHaveBeenCalled();
    const config = (await store.getGuild(guildId)).security.config;
    expect(config.channels).toEqual({
      alerts: '70000000000000001',
      audit: '70000000000000002',
      modLogs: '70000000000000003',
    });
    expect(config.quarantineRoleId).toBe('80000000000000001');
  });

  it('does not adopt a same-name quarantine role that holds permissions', async () => {
    const store = await makeStore();
    const setPermissions = vi.fn();
    const roleCreate = vi.fn();
    const guild = {
      id: guildId,
      ownerId,
      channels: { cache: new Collection(), create: vi.fn(() => Promise.reject(new Error('no'))) },
      roles: {
        cache: new Collection<string, unknown>([
          [
            '80000000000000002',
            {
              id: '80000000000000002',
              name: 'xenon quarantine',
              managed: false,
              permissions: { bitfield: P.BanMembers },
              setPermissions,
            },
          ],
        ]),
        create: roleCreate,
      },
    } as unknown as Guild;
    const service = fakeService({
      saveSnapshot: vi.fn(() => Promise.resolve(undefined)),
      syncAutoMod: vi.fn(() =>
        Promise.resolve({
          created: [],
          updated: [],
          skipped: [],
          conflicts: [],
          xenonOwnedRuleCount: 0,
          existingServerRules: [],
          unavailable: null,
        }),
      ),
    });
    const interaction = fakeInteraction('security', ownerId, P.ManageGuild, {
      subcommand: 'setup',
    });

    await handleSecurityCommand(interaction, guild, store, service);

    expect((await store.getGuild(guildId)).security.config.quarantineRoleId).toBeNull();
    expect(setPermissions).not.toHaveBeenCalled();
    expect(roleCreate).not.toHaveBeenCalled();
    expect(lastReply(interaction)).toContain('marker disabled');
  });

  it('runs a staff timeout inside runManual while the persisted mode is OBSERVE', async () => {
    const store = await makeStore();
    const { guild, target } = moderationGuild(P.ModerateMembers);
    let insideManual = false;
    const timeoutDuringManual: boolean[] = [];
    const timeout = vi.fn((_ms: number | null, _reason: string) => {
      timeoutDuringManual.push(insideManual);
      return Promise.resolve(undefined);
    });
    Object.assign(target, { moderatable: true, timeout });
    const runManual = vi.fn(async (_actorId: string, operation: () => Promise<unknown>) => {
      insideManual = true;
      try {
        return await operation();
      } finally {
        insideManual = false;
      }
    });
    const service = {
      runManual,
      saveCase: vi.fn(() => Promise.resolve(undefined)),
    } as unknown as SecurityService;
    const interaction = fakeInteraction('timeout', ownerId, P.ModerateMembers, {
      user: targetId,
      strings: { reason: 'Cooling off' },
      integers: { minutes: 10 },
    });

    await handleModerationCommand(interaction, guild, store, service);

    expect((await store.getGuild(guildId)).security.config.enforcementMode).toBe('OBSERVE');
    expect(runManual).toHaveBeenCalledWith(ownerId, expect.any(Function));
    expect(timeout).toHaveBeenCalledWith(600_000, 'Cooling off');
    expect(timeoutDuringManual).toEqual([true]);
    expect(lastReply(interaction)).toContain('Completed timeout');
  });

  describe('/security mode', () => {
    const modeService = () =>
      fakeService({
        setEnforcementMode: vi.fn((_guild: Guild, mode: string) =>
          Promise.resolve({
            previous: 'OBSERVE',
            current: mode,
            activeRestrictions: { lockdown: false, quarantines: 0, raidSlowmodeChannels: 0 },
          }),
        ),
      });
    const setMode = (userId: string, confirm: boolean | null, mode = 'enforce') =>
      fakeInteraction('security', userId, P.ManageGuild, {
        group: 'mode',
        subcommand: 'set',
        strings: { mode },
        booleans: { confirm },
      });
    const trust = async (
      store: JsonDiscordRuntimeStore,
      level: 'SECURITY_ADMIN' | 'TRUSTED_STAFF' | 'NORMAL_STAFF' | null,
    ) => {
      const actors: Record<string, TrustLevel> = level === null ? {} : { [moderatorId]: level };
      await store.updateGuild(guildId, (current) => ({
        ...current,
        security: {
          ...current.security,
          config: {
            ...current.security.config,
            trustedActors: actors,
          },
        },
      }));
    };
    const guild = { id: guildId, ownerId } as Guild;

    it.each([null, 'NORMAL_STAFF', 'TRUSTED_STAFF'] as const)(
      'refuses a ManageGuild user with trust %s',
      async (level) => {
        const store = await makeStore();
        await trust(store, level);
        const service = modeService();
        const interaction = setMode(moderatorId, true);

        await handleSecurityCommand(interaction, guild, store, service);

        expect(lastReply(interaction)).toContain('Not authorized');
        expect(service.setEnforcementMode).not.toHaveBeenCalled();
      },
    );

    it('requires explicit confirmation to enable enforce and lists the protections', async () => {
      const store = await makeStore();
      await trust(store, 'SECURITY_ADMIN');
      const service = modeService();
      const unconfirmed = setMode(moderatorId, null);

      await handleSecurityCommand(unconfirmed, guild, store, service);

      expect(service.setEnforcementMode).not.toHaveBeenCalled();
      expect(lastReply(unconfirmed)).toContain('/security mode set mode:enforce confirm:true');
      expect(lastReply(unconfirmed)).toContain('•');

      const confirmed = setMode(moderatorId, true);
      await handleSecurityCommand(confirmed, guild, store, service);

      expect(service.setEnforcementMode).toHaveBeenCalledWith(guild, 'ENFORCE', moderatorId);
      expect(lastReply(confirmed)).toContain('OBSERVE → ENFORCE');
    });

    it('lets the owner switch to observe without confirmation and explains how to release restrictions', async () => {
      const store = await makeStore();
      const service = fakeService({
        setEnforcementMode: vi.fn(() =>
          Promise.resolve({
            previous: 'ENFORCE',
            current: 'OBSERVE',
            activeRestrictions: { lockdown: true, quarantines: 2, raidSlowmodeChannels: 3 },
          }),
        ),
      });
      const interaction = setMode(ownerId, null, 'observe');

      await handleSecurityCommand(interaction, guild, store, service);

      expect(service.setEnforcementMode).toHaveBeenCalledWith(guild, 'OBSERVE', ownerId);
      const text = lastReply(interaction);
      expect(text).toContain('/security unlock');
      expect(text).toContain('/security unquarantine');
      expect(text).toContain('/security raid-mode off');
    });

    it('requires confirmation for enforce even when the persisted mode is already ENFORCE', async () => {
      const store = await makeStore();
      await store.updateGuild(guildId, (current) => ({
        ...current,
        security: {
          ...current.security,
          config: { ...current.security.config, enforcementMode: 'ENFORCE' },
        },
      }));
      const service = modeService();
      const interaction = setMode(ownerId, null);

      await handleSecurityCommand(interaction, guild, store, service);

      expect(service.setEnforcementMode).not.toHaveBeenCalled();
      expect(lastReply(interaction)).toContain('confirm:true');
    });

    it('reports status without changing anything', async () => {
      const store = await makeStore();
      const service = fakeService({ setEnforcementMode: vi.fn() });
      const interaction = fakeInteraction('security', ownerId, P.ManageGuild, {
        group: 'mode',
        subcommand: 'status',
      });

      await handleSecurityCommand(interaction, guild, store, service);

      expect(service.setEnforcementMode).not.toHaveBeenCalled();
      expect(lastReply(interaction)).toContain('Enforcement mode: OBSERVE');
      expect(lastReply(interaction)).toContain('Active restrictions');
    });
  });

  it('keeps /security within Discord command limits', () => {
    const entry = SECURITY_COMMANDS.find((command) => command.name === 'security');
    expect(entry?.options?.length).toBeLessThanOrEqual(25);
    expect(entry?.options?.some((option) => option.name === 'mode')).toBe(true);
  });
});
