import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AuditLogEvent,
  ChannelType,
  Collection,
  GuildExplicitContentFilter,
  GuildMFALevel,
  GuildVerificationLevel,
  PermissionFlagsBits as P,
  PermissionsBitField,
  RateLimitError,
  type EmbedBuilder,
  type Guild,
  type GuildAuditLogsEntry,
  type GuildMember,
  type Message,
} from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JsonDiscordRuntimeStore } from '../runtime-store';

import { SecurityService } from './service';

const guildId = '12345678901234567';
const ownerId = '22345678901234567';
const botId = '62345678901234567';
const alertsId = '32345678901234567';
const lockdownA = '32345678901234568';
const lockdownB = '32345678901234569';
const actorId = '52345678901234567';
const T0 = Date.parse('2026-03-01T12:00:00.000Z');
const MINUTE = 60_000;

interface FakeOverwrite {
  readonly id: string;
  readonly type: 0 | 1;
  readonly allow: PermissionsBitField;
  readonly deny: PermissionsBitField;
}
interface FakeChannel {
  readonly id: string;
  readonly name: string;
  readonly type: ChannelType.GuildText;
  rateLimitPerUser: number;
  readonly permissionOverwrites: { readonly cache: Collection<string, FakeOverwrite> };
  readonly send: ReturnType<typeof vi.fn>;
  readonly setRateLimitPerUser: ReturnType<typeof vi.fn>;
}

function channel(id: string, name: string, overwrites: readonly FakeOverwrite[] = []): FakeChannel {
  const fake: FakeChannel = {
    id,
    name,
    type: ChannelType.GuildText,
    rateLimitPerUser: 0,
    permissionOverwrites: { cache: new Collection(overwrites.map((entry) => [entry.id, entry])) },
    send: vi.fn(() => Promise.resolve()),
    setRateLimitPerUser: vi.fn((seconds: number) => {
      fake.rateLimitPerUser = seconds;
      return Promise.resolve();
    }),
  };
  return fake;
}

function overwrite(id: string, type: 0 | 1, allow: bigint, deny: bigint): FakeOverwrite {
  return {
    id,
    type,
    allow: new PermissionsBitField(allow),
    deny: new PermissionsBitField(deny),
  };
}

interface GuildOptions {
  readonly botPermissions?: bigint;
  readonly everyonePermissions?: bigint;
  readonly channels?: readonly FakeChannel[];
  readonly extraMembers?: readonly Record<string, unknown>[];
  readonly extraRoles?: readonly Record<string, unknown>[];
  readonly hardened?: boolean;
}

function buildGuild(options: GuildOptions = {}): Guild {
  const everyone = {
    id: guildId,
    name: '@everyone',
    position: 0,
    managed: false,
    permissions: new PermissionsBitField(options.everyonePermissions ?? 0n),
  };
  const roles = new Collection<string, Record<string, unknown>>([
    [guildId, everyone],
    ...(options.extraRoles ?? []).map((role) => [role.id as string, role] as const),
  ]);
  const me = {
    id: botId,
    user: { bot: true, tag: 'Xenon#0001' },
    permissions: new PermissionsBitField(
      options.botPermissions ?? P.ViewChannel | P.SendMessages | P.ViewAuditLog,
    ),
    roles: { highest: { position: 10 } },
  };
  const members = new Collection<string, Record<string, unknown>>([
    [botId, me],
    ...(options.extraMembers ?? []).map((member) => [member.id as string, member] as const),
  ]);
  const channels = new Collection<string, FakeChannel>(
    (options.channels ?? []).map((entry) => [entry.id, entry]),
  );
  return {
    id: guildId,
    ownerId,
    client: { user: { id: botId } },
    features: options.hardened === true ? ['COMMUNITY', 'MEMBER_VERIFICATION_GATE_ENABLED'] : [],
    verificationLevel:
      options.hardened === true ? GuildVerificationLevel.High : GuildVerificationLevel.Low,
    mfaLevel: options.hardened === true ? GuildMFALevel.Elevated : GuildMFALevel.None,
    explicitContentFilter:
      options.hardened === true
        ? GuildExplicitContentFilter.AllMembers
        : GuildExplicitContentFilter.Disabled,
    roles: { cache: roles, everyone },
    channels: {
      cache: channels,
      fetch: vi.fn((id: string) => {
        const found = channels.get(id);
        return found === undefined
          ? Promise.reject(new Error('Unknown Channel'))
          : Promise.resolve(found);
      }),
    },
    members: {
      me,
      cache: members,
      fetch: vi.fn((input: string | { readonly user: string }) => {
        const found = members.get(typeof input === 'string' ? input : input.user);
        return found === undefined
          ? Promise.reject(new Error('Unknown Member'))
          : Promise.resolve(found);
      }),
    },
  } as unknown as Guild;
}

function joiner(guild: Guild, index: number, id?: string): GuildMember {
  return {
    id: id ?? String(71345678901234000 + index),
    guild,
    user: { bot: false, createdTimestamp: Date.now() - 400 * 24 * 60 * MINUTE },
  } as unknown as GuildMember;
}

async function configure(
  store: JsonDiscordRuntimeStore,
  patch: Record<string, unknown>,
): Promise<void> {
  await store.updateGuild(guildId, (current) => ({
    ...current,
    security: {
      ...current.security,
      config: { ...current.security.config, enforcementMode: 'ENFORCE', ...patch },
    },
  }));
}

function sentEmbeds(target: FakeChannel): EmbedBuilder[] {
  return target.send.mock.calls.map((call) => (call[0] as { embeds: EmbedBuilder[] }).embeds[0]!);
}

describe('security protection behaviour', () => {
  let directory = '';
  let store: JsonDiscordRuntimeStore;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    directory = await mkdtemp(join(tmpdir(), 'xenon-protection-'));
    store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  });

  describe('raid response', () => {
    const burst = async (service: SecurityService, guild: Guild, offset: number): Promise<void> => {
      for (let index = 0; index < 9; index += 1)
        await service.handleJoin(joiner(guild, offset + index));
    };
    const setup = async (): Promise<{
      guild: Guild;
      a: FakeChannel;
      b: FakeChannel;
      alerts: FakeChannel;
    }> => {
      const alerts = channel(alertsId, 'security-alerts');
      const a = channel(lockdownA, 'general');
      const b = channel(lockdownB, 'chat');
      b.rateLimitPerUser = 120;
      const guild = buildGuild({ channels: [alerts, a, b] });
      await configure(store, {
        lockdownChannelIds: [lockdownA, lockdownB, alertsId],
        channels: { alerts: alertsId, audit: null, modLogs: null },
        autoLockdownOnCritical: false,
      });
      return { guild, a, b, alerts };
    };

    it('applies slowmode on entering a raid, skips higher slowmode and log channels, then restores after the quiet period from a fresh service', async () => {
      const { guild, a, b, alerts } = await setup();
      const service = new SecurityService(store);
      await burst(service, guild, 0);

      const active = (await store.getGuild(guildId)).security.raidResponse;
      expect(active).toMatchObject({
        level: 'RAID',
        slowmode: [{ channelId: lockdownA, before: 0, applied: 30 }],
      });
      expect(a.rateLimitPerUser).toBe(30);
      expect(b.rateLimitPerUser).toBe(120);
      expect(alerts.setRateLimitPerUser).not.toHaveBeenCalled();
      const status = await service.raidStatus(guildId);
      expect(status).toMatchObject({ level: 'RAID', slowmodeChannels: 1, joins10s: 9 });
      expect(status.recoveryAt).toBe(
        new Date(Date.parse(active?.lastEscalationAt ?? '') + 10 * MINUTE).toISOString(),
      );

      vi.setSystemTime(T0 + 9 * MINUTE);
      expect(await service.checkRaidRecovery(guild)).toBe(false);
      expect(a.rateLimitPerUser).toBe(30);

      vi.setSystemTime(T0 + 10 * MINUTE + 1_000);
      const restarted = new SecurityService(store);
      expect(await restarted.checkRaidRecovery(guild)).toBe(true);
      expect(a.rateLimitPerUser).toBe(0);
      const state = (await store.getGuild(guildId)).security;
      expect(state.raidResponse).toBeNull();
      expect(state.incidents.at(-1)).toMatchObject({
        severity: 'INFO',
        title: 'Raid response ended',
        actionTaken: ['Slowmode restored on 1 channel(s)'],
      });
      expect(await restarted.checkRaidRecovery(guild)).toBe(false);
    });

    it('extends the response while elevated joins continue', async () => {
      const { guild } = await setup();
      const service = new SecurityService(store);
      await burst(service, guild, 0);
      vi.setSystemTime(T0 + 8 * MINUTE);
      await burst(service, guild, 100);

      vi.setSystemTime(T0 + 11 * MINUTE);
      expect(await service.checkRaidRecovery(guild)).toBe(false);
      vi.setSystemTime(T0 + 19 * MINUTE);
      expect(await service.checkRaidRecovery(guild)).toBe(true);
    });

    it('leaves slowmode that a moderator changed during the raid and records the conflict', async () => {
      const { guild, a } = await setup();
      const service = new SecurityService(store);
      await burst(service, guild, 0);
      a.rateLimitPerUser = 300;

      vi.setSystemTime(T0 + 11 * MINUTE);
      expect(await service.checkRaidRecovery(guild)).toBe(true);
      expect(a.rateLimitPerUser).toBe(300);
      const ended = (await store.getGuild(guildId)).security.incidents.at(-1);
      expect(ended?.evidence.some((line) => line.includes('left unchanged'))).toBe(true);
    });

    it('keeps the response while raid mode is forced ON', async () => {
      const { guild, a } = await setup();
      const service = new SecurityService(store);
      await burst(service, guild, 0);
      await configure(store, { raidMode: 'ON' });

      vi.setSystemTime(T0 + 30 * MINUTE);
      expect(await service.checkRaidRecovery(guild)).toBe(false);
      expect(a.rateLimitPerUser).toBe(30);
    });

    it('releases the response immediately when staff turn raid mode OFF', async () => {
      const { guild, a } = await setup();
      const service = new SecurityService(store);
      await burst(service, guild, 0);
      await configure(store, { raidMode: 'OFF' });

      vi.setSystemTime(T0 + MINUTE);
      expect(await service.checkRaidRecovery(guild)).toBe(true);
      expect(a.rateLimitPerUser).toBe(0);
      expect((await store.getGuild(guildId)).security.raidResponse).toBeNull();
    });

    it('records a rate-limited slowmode failure without throwing and still persists the response', async () => {
      const { guild, a } = await setup();
      a.setRateLimitPerUser.mockRejectedValue(
        Object.create(RateLimitError.prototype, { message: { value: 'limited' } }),
      );
      await burst(new SecurityService(store), guild, 0);

      const state = (await store.getGuild(guildId)).security;
      expect(state.raidResponse).toMatchObject({ level: 'RAID', slowmode: [] });
      const incident = state.incidents.find((entry) => entry.rule === 'JOIN_WINDOW_RAID');
      expect(
        incident?.actionTaken.some((action) => action.startsWith('RAID_SLOWMODE_FAILED')),
      ).toBe(true);
      expect(incident?.actionTaken.join(' ')).toContain('rate limited');
    });

    it('does nothing to channels when slowmode is disabled', async () => {
      const { guild, a } = await setup();
      await configure(store, { raidSlowmodeSeconds: 0 });
      await burst(new SecurityService(store), guild, 0);
      expect(a.setRateLimitPerUser).not.toHaveBeenCalled();
      expect((await store.getGuild(guildId)).security.raidResponse?.slowmode).toEqual([]);
    });

    it('keeps a journal entry when a rejected apply actually took effect and drops one that did not', async () => {
      const { guild, a, b } = await setup();
      b.rateLimitPerUser = 0;
      await configure(store, { lockdownChannelIds: [lockdownA, lockdownB] });
      const lost = Object.create(RateLimitError.prototype, { message: { value: 'lost' } }) as Error;
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      a.setRateLimitPerUser.mockImplementation((seconds: number) => {
        a.rateLimitPerUser = seconds;
        return Promise.reject(lost);
      });
      b.setRateLimitPerUser.mockRejectedValue(lost);
      await burst(new SecurityService(store), guild, 0);

      expect((await store.getGuild(guildId)).security.raidResponse?.slowmode).toEqual([
        { channelId: lockdownA, before: 0, applied: 30 },
      ]);
      vi.setSystemTime(T0 + 11 * MINUTE);
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      a.setRateLimitPerUser.mockImplementation((seconds: number) => {
        a.rateLimitPerUser = seconds;
        return Promise.resolve();
      });
      expect(await new SecurityService(store).checkRaidRecovery(guild)).toBe(true);
      expect(a.rateLimitPerUser).toBe(0);
    });

    it('journals each slowmode change before calling Discord', async () => {
      const { guild, a } = await setup();
      let journaledAtCall: readonly string[] | null = null;
      // The channel fake's mock is typed as a void procedure but the real call is awaited.
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      a.setRateLimitPerUser.mockImplementation((seconds: number) =>
        store.getGuild(guildId).then((state) => {
          journaledAtCall =
            state.security.raidResponse?.slowmode.map((entry) => entry.channelId) ?? null;
          a.rateLimitPerUser = seconds;
        }),
      );
      await burst(new SecurityService(store), guild, 0);
      expect(journaledAtCall).toEqual([lockdownA]);
    });

    it('drops a journaled entry whose apply never happened without reporting a conflict', async () => {
      const { guild, a } = await setup();
      await store.updateGuild(guildId, (current) => ({
        ...current,
        security: {
          ...current.security,
          raidResponse: {
            level: 'RAID',
            since: new Date(T0 - 20 * MINUTE).toISOString(),
            lastEscalationAt: new Date(T0 - 20 * MINUTE).toISOString(),
            incidentId: null,
            slowmode: [{ channelId: lockdownA, before: 0, applied: 30 }],
          },
        },
      }));
      expect(await new SecurityService(store).checkRaidRecovery(guild)).toBe(true);
      expect(a.setRateLimitPerUser).not.toHaveBeenCalled();
      const ended = (await store.getGuild(guildId)).security.incidents.at(-1);
      expect(ended?.evidence).toHaveLength(1);
    });

    it('keeps entries whose restore failed and finishes the rollback on a later check', async () => {
      const { guild, a } = await setup();
      const service = new SecurityService(store);
      await burst(service, guild, 0);
      a.setRateLimitPerUser.mockRejectedValueOnce(
        Object.create(RateLimitError.prototype, { message: { value: 'limited' } }),
      );

      vi.setSystemTime(T0 + 11 * MINUTE);
      expect(await service.checkRaidRecovery(guild)).toBe(false);
      expect(a.rateLimitPerUser).toBe(30);
      expect((await store.getGuild(guildId)).security.raidResponse?.slowmode).toEqual([
        { channelId: lockdownA, before: 0, applied: 30 },
      ]);

      expect(await service.checkRaidRecovery(guild)).toBe(true);
      expect(a.rateLimitPerUser).toBe(0);
      expect((await store.getGuild(guildId)).security.raidResponse).toBeNull();
    });

    it('does not quarantine the owner or Xenon-trusted arrivals during an automatic raid', async () => {
      const { guild } = await setup();
      const trustedId = '71345678901234777';
      await configure(store, { trustedActors: { [trustedId]: 'TRUSTED_STAFF' } });
      const service = new SecurityService(store);
      await burst(service, guild, 0);
      const quarantine = vi.spyOn(service, 'quarantine').mockResolvedValue('QUARANTINED:test');
      await service.handleJoin(joiner(guild, 0, trustedId));
      await service.handleJoin(joiner(guild, 0, ownerId));
      expect(quarantine).not.toHaveBeenCalled();
      await service.handleJoin(joiner(guild, 500));
      expect(quarantine).toHaveBeenCalledTimes(1);
    });
  });

  describe('alert throttling', () => {
    it('persists every similar incident, posts one alert per window, then reports the suppressed count', async () => {
      const alerts = channel(alertsId, 'security-alerts');
      const guild = buildGuild({ channels: [alerts] });
      await configure(store, { channels: { alerts: alertsId, audit: null, modLogs: null } });
      const service = new SecurityService(store);

      for (let index = 0; index < 4; index += 1)
        await service.recordManualRaidMode(guild, actorId, 'ON');
      expect((await store.getGuild(guildId)).security.incidents).toHaveLength(4);
      expect(alerts.send).toHaveBeenCalledTimes(1);

      vi.setSystemTime(T0 + 61_000);
      await service.recordManualRaidMode(guild, actorId, 'ON');
      expect(alerts.send).toHaveBeenCalledTimes(2);
      const incidents = (await store.getGuild(guildId)).security.incidents;
      const field = sentEmbeds(alerts)[1]?.data.fields?.find(
        (entry) => entry.name === 'Suppressed similar alerts',
      );
      expect(field?.value).toContain('3 similar alert(s)');
      for (const suppressed of incidents.slice(1, 4)) expect(field?.value).toContain(suppressed.id);
      expect(
        sentEmbeds(alerts)[0]?.data.fields?.some(
          (entry) => entry.name === 'Suppressed similar alerts',
        ),
      ).toBe(false);
    });

    it('does not suppress a different actor or an escalation in severity', async () => {
      const alerts = channel(alertsId, 'security-alerts');
      const guild = buildGuild({ channels: [alerts] });
      await configure(store, { channels: { alerts: alertsId, audit: null, modLogs: null } });
      const service = new SecurityService(store);
      await service.recordManualRaidMode(guild, actorId, 'ON');
      await service.recordManualRaidMode(guild, '52345678901234568', 'ON');
      expect(alerts.send).toHaveBeenCalledTimes(2);
    });
  });

  describe('spam enforcement', () => {
    const channelIds = [
      '82345678901234561',
      '82345678901234562',
      '82345678901234563',
      '82345678901234564',
      '82345678901234565',
    ];
    const makeMember = () => ({
      id: '92345678901234567',
      roles: { cache: new Collection() },
      moderatable: true,
      timeout: vi.fn(() => Promise.resolve()),
      send: vi.fn(() => Promise.resolve()),
    });
    let counter = 0;
    const makeMessage = (
      guild: Guild,
      member: ReturnType<typeof makeMember>,
      content: string,
      at: number,
      channelId = channelIds[0]!,
    ) => {
      counter += 1;
      return {
        id: `1${String(counter).padStart(16, '0')}`,
        guild,
        member,
        author: { id: member.id, bot: false },
        webhookId: null,
        channelId,
        content,
        createdTimestamp: at,
        inGuild: () => true,
        mentions: { users: { size: 0 }, roles: { size: 0 }, everyone: false },
        delete: vi.fn(() => Promise.resolve()),
      };
    };
    const asMessage = (message: unknown): Message => message as Message;

    it('creates one case for a burst, deletes the rest, and reports suppressed detections on the next case', async () => {
      const guild = buildGuild();
      await configure(store, {});
      const service = new SecurityService(store);
      service.setMessageContentAvailable(true);
      const member = makeMember();
      const messages = Array.from({ length: 6 }, (_, index) =>
        makeMessage(guild, member, 'free nitro at this totally real site', T0 + index * 100),
      );
      for (const message of messages) await service.handleMessage(asMessage(message));

      let state = (await store.getGuild(guildId)).security;
      expect(state.cases).toHaveLength(1);
      expect(messages.map((message) => message.delete.mock.calls.length)).toEqual([
        0, 0, 1, 1, 1, 1,
      ]);
      expect(member.send).toHaveBeenCalledTimes(1);
      expect(member.timeout).not.toHaveBeenCalled();

      vi.setSystemTime(T0 + 16_000);
      await service.handleMessage(
        asMessage(makeMessage(guild, member, 'free nitro at this totally real site', T0 + 16_000)),
      );
      state = (await store.getGuild(guildId)).security;
      expect(state.cases).toHaveLength(2);
      expect(state.cases[1]?.reason).toContain('(+3 suppressed detections)');
    });

    it('treats a second invite within 30 seconds as spam even when link policy is off', async () => {
      const guild = buildGuild();
      await configure(store, {
        modules: { ...(await store.getGuild(guildId)).security.config.modules, linkGuard: false },
      });
      const service = new SecurityService(store);
      service.setMessageContentAvailable(true);
      const member = makeMember();
      const first = makeMessage(guild, member, 'join discord.gg/abc', T0);
      const second = makeMessage(guild, member, 'also discord.gg/xyz', T0 + 5_000);
      await service.handleMessage(asMessage(first));
      expect(first.delete).not.toHaveBeenCalled();
      await service.handleMessage(asMessage(second));

      expect(second.delete).toHaveBeenCalledTimes(1);
      const state = (await store.getGuild(guildId)).security;
      expect(state.cases).toHaveLength(1);
      expect(state.cases[0]?.reason).toContain('repeated invites');
    });

    it('escalates cross-channel spam to a timeout, a mod case and a persisted alerted incident without banning', async () => {
      const alerts = channel(alertsId, 'security-alerts');
      const guild = buildGuild({ channels: [alerts] });
      await configure(store, { channels: { alerts: alertsId, audit: null, modLogs: null } });
      const service = new SecurityService(store);
      service.setMessageContentAvailable(true);
      const member = makeMember();
      const contents = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
      for (const [index, content] of contents.entries())
        await service.handleMessage(
          asMessage(makeMessage(guild, member, content, T0 + index * 100, channelIds[index])),
        );

      expect(member.timeout).toHaveBeenCalledTimes(1);
      const state = (await store.getGuild(guildId)).security;
      expect(state.cases).toHaveLength(1);
      expect(state.cases[0]).toMatchObject({ action: 'TIMEOUT', targetId: member.id });
      expect(state.incidents).toHaveLength(1);
      expect(state.incidents[0]).toMatchObject({
        severity: 'HIGH',
        source: 'SpamGuard',
        actorId: member.id,
        status: 'CONTAINED',
      });
      expect(alerts.send).toHaveBeenCalledTimes(1);
    });

    it('persists every link warning but direct-messages the member at most once a minute', async () => {
      const guild = buildGuild();
      await configure(store, {
        modules: { ...(await store.getGuild(guildId)).security.config.modules, spam: false },
        links: { ...(await store.getGuild(guildId)).security.config.links, blockInvites: false },
      });
      const service = new SecurityService(store);
      service.setMessageContentAvailable(true);
      const member = makeMember();
      for (let index = 0; index < 2; index += 1)
        await service.handleMessage(
          asMessage(makeMessage(guild, member, 'see https://example.org/page', T0 + index)),
        );

      expect(member.send).toHaveBeenCalledTimes(1);
      const incidents = (await store.getGuild(guildId)).security.incidents;
      expect(incidents.map((incident) => incident.rule)).toEqual(['LINK_WARN', 'LINK_WARN']);

      vi.setSystemTime(T0 + 61_000);
      await service.handleMessage(
        asMessage(makeMessage(guild, member, 'see https://example.org/page', T0 + 61_000)),
      );
      expect(member.send).toHaveBeenCalledTimes(2);
    });
  });

  describe('permission scanner and native safety', () => {
    const botMember = {
      id: '82345678901234500',
      user: { bot: true, tag: 'Helper#0001' },
      permissions: new PermissionsBitField(P.ManageRoles),
    };

    it('flags an @everyone Administrator grant as critical and reports concrete remediation for every finding', async () => {
      const privateChannel = channel('42345678901234561', 'vault', [
        overwrite(guildId, 0, 0n, P.ViewChannel),
        overwrite('92345678901234567', 1, P.ManageChannels, 0n),
      ]);
      const openChannel = channel('42345678901234562', 'lobby', [
        overwrite(guildId, 0, P.ManageWebhooks, 0n),
      ]);
      const guild = buildGuild({
        everyonePermissions: P.Administrator,
        channels: [privateChannel, openChannel],
        extraMembers: [botMember],
      });
      const findings = await new SecurityService(store).scanPermissions(guild);
      const byCode = (code: string) => findings.find((finding) => finding.code === code);

      expect(byCode('DANGEROUS_EVERYONE_PERMISSION')?.severity).toBe('CRITICAL');
      expect(byCode('BOT_OVERPRIVILEGED')).toMatchObject({
        severity: 'MEDIUM',
        subject: 'Helper#0001',
      });
      expect(byCode('PRIVATE_CHANNEL_PERMISSION_DELEGATION')).toMatchObject({
        severity: 'MEDIUM',
        subject: 'vault',
      });
      expect(byCode('EVERYONE_CHANNEL_MANAGEMENT_OVERWRITE')).toMatchObject({
        severity: 'HIGH',
        subject: 'lobby',
      });
      expect(byCode('MISSING_AUDIT_LOG_CHANNEL')?.severity).toBe('MEDIUM');
      expect(byCode('MISSING_MOD_LOG_CHANNEL')?.severity).toBe('MEDIUM');
      expect(byCode('NATIVE_MFA_REQUIREMENT')?.severity).toBe('LOW');
      expect(byCode('NATIVE_VERIFICATION_LEVEL')?.severity).toBe('MEDIUM');
      expect(findings.length).toBeGreaterThan(0);
      for (const finding of findings) expect(finding.remediation.trim()).not.toBe('');
    });

    it('excludes XenonBot ticket-channel overwrites from user-delegation findings', async () => {
      const ticketChannel = channel('42345678901234563', 'xenon-ticket-queue', [
        overwrite(guildId, 0, 0n, P.ViewChannel),
        overwrite(botId, 1, P.ManageChannels | P.ManageRoles, 0n),
      ]);

      const findings = await new SecurityService(store).scanPermissions(
        buildGuild({ channels: [ticketChannel] }),
      );

      expect(
        findings.filter((finding) => finding.code === 'PRIVATE_CHANNEL_PERMISSION_DELEGATION'),
      ).toHaveLength(0);
    });

    it('reports an unexpected Administrator role only once', async () => {
      const administratorRole = {
        id: '72345678901234991',
        name: 'Legacy Admin',
        position: 2,
        managed: false,
        permissions: new PermissionsBitField(P.Administrator),
      };

      const findings = await new SecurityService(store).scanPermissions(
        buildGuild({ extraRoles: [administratorRole] }),
      );
      const roleFindings = findings.filter((finding) => finding.subject === administratorRole.name);

      expect(roleFindings).toHaveLength(1);
      expect(roleFindings[0]?.code).toBe('UNEXPECTED_DANGEROUS_ROLE');
    });

    it('retains every member delegation in a private-channel finding', async () => {
      const delegateIds = Array.from(
        { length: 6 },
        (_, index) => `9234567890123400${String(index + 1)}`,
      );
      const privateChannel = channel('42345678901234564', 'support-queue', [
        overwrite(guildId, 0, 0n, P.ViewChannel),
        ...delegateIds.map((id) => overwrite(id, 1, P.ManageChannels, 0n)),
      ]);

      const findings = await new SecurityService(store).scanPermissions(
        buildGuild({ channels: [privateChannel] }),
      );

      expect(
        findings.find((finding) => finding.code === 'PRIVATE_CHANNEL_PERMISSION_DELEGATION')
          ?.detail,
      ).toContain(delegateIds.join(', '));
    });

    it('rates a non-administrator @everyone dangerous grant as high', async () => {
      const findings = await new SecurityService(store).scanPermissions(
        buildGuild({ everyonePermissions: P.ManageRoles }),
      );
      expect(
        findings.find((finding) => finding.code === 'DANGEROUS_EVERYONE_PERMISSION')?.severity,
      ).toBe('HIGH');
    });

    it('reports native settings read-only, with owner-only and unverifiable items as manual', () => {
      const service = new SecurityService(store);
      const weak = service.nativeSafety(buildGuild());
      const status = (name: string) => weak.find((check) => check.name.includes(name))?.status;
      expect(status('Verification')).toBe('WARN');
      expect(status('2FA')).toBe('MANUAL ACTION REQUIRED');
      expect(status('content filter')).toBe('WARN');
      expect(status('Community')).toBe('MANUAL ACTION REQUIRED');
      expect(status('Raid Protection')).toBe('MANUAL ACTION REQUIRED');
      expect(status('@everyone')).toBe('OK');

      const strong = service.nativeSafety(buildGuild({ hardened: true }));
      expect(strong.filter((check) => check.status !== 'OK').map((check) => check.name)).toEqual([
        'Discord Raid Protection / Safety Setup',
      ]);
      expect(
        service
          .nativeSafety(buildGuild({ everyonePermissions: P.BanMembers }))
          .find((check) => check.name.includes('@everyone'))?.status,
      ).toBe('WARN');
    });

    it('flags a quarantine marker role that grants permissions', async () => {
      const markerId = '72345678901234999';
      const guild = buildGuild({
        extraRoles: [
          {
            id: markerId,
            name: 'Quarantined',
            position: 2,
            managed: false,
            permissions: new PermissionsBitField(P.SendMessages),
          },
        ],
      });
      await configure(store, { quarantineRoleId: markerId });
      const findings = await new SecurityService(store).scanPermissions(guild);
      expect(
        findings.find((finding) => finding.code === 'QUARANTINE_ROLE_HAS_PERMISSIONS'),
      ).toMatchObject({
        severity: 'HIGH',
        subject: 'Quarantined',
      });
    });
  });

  describe('unattributed destructive events', () => {
    const run = async (
      service: SecurityService,
      guild: Guild,
      kind: 'CHANNEL_DELETE' | 'ROLE_DELETE' | 'MEMBER_BAN',
      count: number,
    ): Promise<void> => {
      for (let index = 0; index < count; index += 1)
        await service.handleUnattributedEvent(guild, kind, String(42345678901234000 + index));
    };

    it('alerts once per kind at its threshold with unavailable attribution and never contains', async () => {
      const alerts = channel(alertsId, 'security-alerts');
      const guild = buildGuild({
        botPermissions: P.ViewChannel | P.SendMessages,
        channels: [alerts],
      });
      await configure(store, { channels: { alerts: alertsId, audit: null, modLogs: null } });
      const service = new SecurityService(store);

      await run(service, guild, 'CHANNEL_DELETE', 2);
      expect((await store.getGuild(guildId)).security.incidents).toHaveLength(0);
      await run(service, guild, 'CHANNEL_DELETE', 5);
      await run(service, guild, 'ROLE_DELETE', 2);
      await run(service, guild, 'MEMBER_BAN', 4);

      const state = (await store.getGuild(guildId)).security;
      expect(state.incidents.map((incident) => incident.rule)).toEqual([
        'UNATTRIBUTED_CHANNEL_DELETE',
        'UNATTRIBUTED_ROLE_DELETE',
      ]);
      for (const incident of state.incidents) {
        expect(incident).toMatchObject({
          severity: 'HIGH',
          actorId: null,
          auditCorrelation: 'UNAVAILABLE',
          status: 'OPEN',
        });
        expect(incident.evidence.join(' ')).toContain('View Audit Log');
      }
      expect(state.lockdown).toBeNull();
      expect(state.quarantines).toEqual([]);
      expect(alerts.send).toHaveBeenCalledTimes(2);
      await run(service, guild, 'MEMBER_BAN', 1);
      expect((await store.getGuild(guildId)).security.incidents).toHaveLength(3);
    });

    it('forgets events outside the 60 second window and ignores guilds that can read the audit log', async () => {
      const blind = buildGuild({ botPermissions: P.ViewChannel });
      const service = new SecurityService(store);
      await service.handleUnattributedEvent(blind, 'ROLE_DELETE', '42345678901234001');
      vi.setSystemTime(T0 + 61_000);
      await service.handleUnattributedEvent(blind, 'ROLE_DELETE', '42345678901234002');
      expect((await store.getGuild(guildId)).security.incidents).toHaveLength(0);

      const sighted = buildGuild({ botPermissions: P.ViewChannel | P.ViewAuditLog });
      await run(service, sighted, 'MEMBER_BAN', 10);
      expect((await store.getGuild(guildId)).security.incidents).toHaveLength(0);
    });
  });

  describe('containment failures', () => {
    it('leaves the incident open and does not throw when Discord rate-limits dangerous-role removal', async () => {
      const dangerousRole = {
        id: '72345678901234001',
        name: 'Mods',
        position: 3,
        managed: false,
        permissions: new PermissionsBitField(P.ManageChannels),
      };
      const remove = vi.fn(() =>
        Promise.reject(
          Object.create(RateLimitError.prototype, {
            message: { value: 'limited' },
          }) as RateLimitError,
        ),
      );
      const actor = {
        id: actorId,
        manageable: true,
        moderatable: true,
        roles: { cache: new Collection([[dangerousRole.id, dangerousRole]]), remove },
        timeout: vi.fn(() => Promise.reject(new Error('should not be reached'))),
      };
      const guild = buildGuild({ extraMembers: [actor], extraRoles: [dangerousRole] });
      await configure(store, { autoLockdownOnCritical: false });
      const service = new SecurityService(store);
      const entry = (index: number) =>
        ({
          id: `9234567890123450${String(index)}`,
          action: AuditLogEvent.ChannelDelete,
          executorId: actorId,
          targetId: `4234567890123450${String(index)}`,
          createdTimestamp: Date.now(),
          reason: null,
          changes: [],
          extra: null,
        }) as unknown as GuildAuditLogsEntry;

      for (let index = 0; index < 3; index += 1)
        await expect(service.handleAuditEntry(entry(index), guild)).resolves.toBeUndefined();

      expect(remove).toHaveBeenCalledTimes(1);
      const incident = (await store.getGuild(guildId)).security.incidents.find(
        (record) => record.severity === 'CRITICAL',
      );
      expect(incident?.status).toBe('OPEN');
      expect(incident?.actionTaken[0]).toContain('Dangerous-role removal failed (rate limited');
    });
  });

  describe('incident resolution', () => {
    it('resolves once, persists who/when/why, and is idempotent', async () => {
      const audit = channel(alertsId, 'security-audit');
      const guild = buildGuild({ channels: [audit] });
      await configure(store, { channels: { alerts: null, audit: alertsId, modLogs: null } });
      const service = new SecurityService(store);
      await service.recordManualRaidMode(guild, actorId, 'ON');
      const id = (await store.getGuild(guildId)).security.incidents[0]?.id ?? '';

      expect(await service.resolveIncident(guild, 'XEN-SEC-MISSING', ownerId, 'x')).toBe(
        'NOT_FOUND',
      );
      vi.setSystemTime(T0 + MINUTE);
      expect(await service.resolveIncident(guild, id, ownerId, `  ${'n'.repeat(600)}  `)).toBe(
        'RESOLVED',
      );
      const resolved = (await store.getGuild(guildId)).security.incidents[0];
      expect(resolved).toMatchObject({
        status: 'RESOLVED',
        resolvedBy: ownerId,
        resolvedAt: new Date(T0 + MINUTE).toISOString(),
      });
      expect(resolved?.resolution).toHaveLength(500);
      const embedCount = audit.send.mock.calls.length;

      expect(await service.resolveIncident(guild, id, actorId, 'again')).toBe('ALREADY_RESOLVED');
      expect((await store.getGuild(guildId)).security.incidents[0]?.resolvedBy).toBe(ownerId);
      expect(audit.send.mock.calls.length).toBe(embedCount);

      const reloaded = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
      expect((await reloaded.getGuild(guildId)).security.incidents[0]?.resolution).toHaveLength(
        500,
      );
    });
  });
});
