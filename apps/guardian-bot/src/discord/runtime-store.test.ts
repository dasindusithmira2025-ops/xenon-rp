import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acquireRuntimeInstanceLock,
  DEFAULT_WELCOME,
  JsonDiscordRuntimeStore,
} from './runtime-store';
import { createCase, createIncident } from './security/model';

const guildId = '12345678901234567';
const roomId = '22345678901234567';

describe('Discord-only runtime persistence', () => {
  let directory = '';

  afterEach(async () => {
    if (directory !== '') await rm(directory, { recursive: true, force: true });
    directory = '';
  });

  it('survives a process restart using only Discord-owned state', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-runtime-'));
    const file = join(directory, 'discord-runtime.json');
    const first = new JsonDiscordRuntimeStore(file);
    await first.saveFeatures(guildId, { tempVoice: false, automod: true });
    await first.saveWelcomeConfig(guildId, {
      ...DEFAULT_WELCOME,
      dmEnabled: true,
      channelId: roomId,
    });
    await first.registry(guildId).upsert({
      logicalKey: 'panel.welcome',
      resourceType: 'PANEL',
      discordId: roomId,
      channelId: '32345678901234567',
      managed: true,
      contentHash: 'hash',
      configurationHash: null,
      createdByRunId: 'run-id',
      metadata: { blueprintVersion: 'discord-blueprint-v1' },
    });
    await first.saveRoom({
      guildId,
      channelId: roomId,
      ownerId: '42345678901234567',
      createdAt: '2026-10-04T12:00:00.000Z',
    });

    const restarted = new JsonDiscordRuntimeStore(file);
    const state = await restarted.getGuild(guildId);
    expect(state.features).toMatchObject({ tempVoice: false, automod: true });
    expect(state.welcome).toMatchObject({ dmEnabled: true, channelId: roomId, enabled: true });
    expect(state.entries[0]?.logicalKey).toBe('panel.welcome');
    expect(state.rooms[roomId]?.ownerId).toBe('42345678901234567');
  });

  it('never writes secrets and rejects sensitive registry metadata', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-runtime-'));
    const file = join(directory, 'discord-runtime.json');
    const store = new JsonDiscordRuntimeStore(file);
    await expect(
      store.registry(guildId).upsert({
        logicalKey: 'panel.welcome',
        resourceType: 'PANEL',
        discordId: roomId,
        channelId: '32345678901234567',
        managed: true,
        contentHash: null,
        configurationHash: null,
        createdByRunId: null,
        metadata: { token: 'must-never-be-written' },
      }),
    ).rejects.toThrow(/Sensitive field/);
    await store.saveWelcomeConfig(guildId, DEFAULT_WELCOME);
    const contents = await readFile(file, 'utf8');
    expect(contents).not.toMatch(/token|secret|password|database|redis|auth/i);
    expect(contents).not.toContain('must-never-be-written');
    expect((await readdir(directory)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });
  it('persists trusted actors, incidents, cases, snapshots, and lockdown recovery data across restart', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-security-runtime-'));
    const file = join(directory, 'discord-runtime.json');
    const store = new JsonDiscordRuntimeStore(file);
    const actorId = '52345678901234567';
    const channelId = '62345678901234567';
    const incident = createIncident({
      severity: 'CRITICAL',
      title: 'Mass channel deletion',
      source: 'AntiNukeEngine',
      rule: 'CHANNEL_DELETE_3_IN_30000MS',
      actorId,
      targetId: channelId,
      evidence: ['3 channels in 18 seconds'],
      automatic: true,
      actionTaken: ['Lockdown activated'],
      auditCorrelation: 'CONFIRMED',
    });
    const moderationCase = createCase({
      action: 'WARN',
      moderatorId: actorId,
      targetId: '72345678901234567',
      reason: 'Repeated spam',
      durationSeconds: null,
      evidenceReference: 'message 82345678901234567',
    });
    const state = await store.getGuild(guildId);
    const snapshot = {
      createdAt: '2026-10-08T12:00:00.000Z',
      roles: [],
      channels: [],
      config: state.security.config,
    };
    await store.updateGuild(guildId, (current) => ({
      ...current,
      security: {
        ...current.security,
        config: {
          ...current.security.config,
          trustedActors: { [actorId]: 'TRUSTED_STAFF' },
          channels: { alerts: channelId, audit: null, modLogs: null },
        },
        incidents: [incident],
        cases: [moderationCase],
        lockdown: {
          startedAt: '2026-10-08T12:01:00.000Z',
          reason: 'Active raid',
          incidentId: incident.id,
          channels: [
            { channelId, overwrites: [{ id: guildId, type: 0, allow: '0', deny: '2048' }] },
          ],
        },
        snapshots: [snapshot],
      },
    }));

    const restarted = new JsonDiscordRuntimeStore(file);
    const restored = (await restarted.getGuild(guildId)).security;
    expect(restored.config.trustedActors[actorId]).toBe('TRUSTED_STAFF');
    expect(restored.incidents[0]).toMatchObject({
      id: incident.id,
      auditCorrelation: 'CONFIRMED',
      status: 'OPEN',
    });
    expect(restored.cases[0]).toMatchObject({
      id: moderationCase.id,
      action: 'WARN',
      targetId: '72345678901234567',
    });
    expect(restored.lockdown?.channels[0]?.overwrites[0]).toEqual({
      id: guildId,
      type: 0,
      allow: '0',
      deny: '2048',
    });
    expect(restored.snapshots[0]?.createdAt).toBe(snapshot.createdAt);
  });

  it('loads pre-security JSON documents with safe security defaults', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-legacy-runtime-'));
    const file = join(directory, 'discord-runtime.json');
    await writeFile(
      file,
      JSON.stringify({ version: 1, guilds: { [guildId]: { entries: [], features: {} } } }),
      'utf8',
    );
    const store = new JsonDiscordRuntimeStore(file);
    expect((await store.getGuild(guildId)).security.config.raidMode).toBe('AUTO');
    await store.saveFeatures(guildId, { automod: true });
    expect(
      (await new JsonDiscordRuntimeStore(file).getGuild(guildId)).security.lockdown,
    ).toBeNull();
  });

  describe('runtime instance lock', () => {
    const record = (fields: { pid?: number; host?: string; token?: string; heartbeatAt?: Date }) =>
      JSON.stringify({
        pid: fields.pid ?? 2_147_483_000,
        host: fields.host ?? hostname(),
        token: fields.token ?? 'other',
        startedAt: new Date(0).toISOString(),
        heartbeatAt: (fields.heartbeatAt ?? new Date()).toISOString(),
      });
    const lockFiles = async () =>
      (await readdir(directory)).filter((name) => name.includes('.lock'));
    const heldRecord = async (lockFile: string): Promise<unknown> =>
      JSON.parse(await readFile(lockFile, 'utf8'));

    afterEach(() => {
      vi.useRealTimers();
    });

    it('refuses a second runtime in the same process and frees the lock on release', async () => {
      directory = await mkdtemp(join(tmpdir(), 'xenon-instance-lock-'));
      const file = join(directory, 'discord-runtime.json');
      const lock = await acquireRuntimeInstanceLock(file);
      await expect(acquireRuntimeInstanceLock(file)).rejects.toThrow(
        /Another Xenon Discord runtime/,
      );
      await lock.release();
      expect(await lockFiles()).toEqual([]);
      await (await acquireRuntimeInstanceLock(file)).release();
    });

    it('honours another host until its lease expires and fails closed on an unreadable lock', async () => {
      directory = await mkdtemp(join(tmpdir(), 'xenon-instance-lock-lease-'));
      const file = join(directory, 'discord-runtime.json');
      const lockFile = `${file}.lock`;

      await writeFile(lockFile, '', 'utf8');
      await expect(acquireRuntimeInstanceLock(file)).rejects.toThrow(/unreadable/);

      await writeFile(lockFile, record({ host: 'another-host.invalid' }), 'utf8');
      await expect(acquireRuntimeInstanceLock(file)).rejects.toThrow(/another-host\.invalid/);

      await writeFile(
        lockFile,
        record({ host: 'another-host.invalid', heartbeatAt: new Date(Date.now() - 121_000) }),
        'utf8',
      );
      const lock = await acquireRuntimeInstanceLock(file);
      expect(await heldRecord(lockFile)).toMatchObject({ pid: process.pid, host: hostname() });
      expect(await heldRecord(lockFile)).not.toMatchObject({ token: 'other' });
      await lock.release();
    });

    it('admits exactly one of several concurrent claimants over a dead same-host lock', async () => {
      directory = await mkdtemp(join(tmpdir(), 'xenon-instance-lock-race-'));
      const file = join(directory, 'discord-runtime.json');
      await writeFile(`${file}.lock`, record({ token: 'dead' }), 'utf8');
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => acquireRuntimeInstanceLock(file)),
      );
      const winners = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      expect(winners).toHaveLength(1);
      expect(await heldRecord(`${file}.lock`)).not.toMatchObject({ token: 'dead' });
      await winners[0]?.release();
      expect(await lockFiles()).toEqual([]);
    });

    it('renews its lease and reports a takeover instead of silently continuing', async () => {
      directory = await mkdtemp(join(tmpdir(), 'xenon-instance-lock-lost-'));
      const file = join(directory, 'discord-runtime.json');
      const lockFile = `${file}.lock`;
      const lost: string[] = [];
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const lock = await acquireRuntimeInstanceLock(file, {
        heartbeatMs: 3_600_000,
        onLost: (detail) => lost.push(detail),
      });
      vi.setSystemTime(new Date('2026-01-01T00:00:30.000Z'));
      await lock.renew();
      expect(await heldRecord(lockFile)).toMatchObject({
        heartbeatAt: '2026-01-01T00:00:30.000Z',
      });

      await writeFile(lockFile, record({ host: 'another-host.invalid', token: 'usurper' }), 'utf8');
      await lock.renew();
      await lock.renew();
      expect(lost).toHaveLength(1);
      expect(lost[0]).toMatch(/another-host\.invalid/);
      await lock.release();
      expect(await heldRecord(lockFile)).toMatchObject({ token: 'usurper' });
    });

    it('stops itself instead of renewing once its lease may have expired', async () => {
      directory = await mkdtemp(join(tmpdir(), 'xenon-instance-lock-fence-'));
      const file = join(directory, 'discord-runtime.json');
      const lost: string[] = [];
      vi.useFakeTimers({ toFake: ['performance'] });
      const lock = await acquireRuntimeInstanceLock(file, {
        heartbeatMs: 30_000,
        onLost: (detail) => lost.push(detail),
      });
      const before = await heldRecord(`${file}.lock`);
      vi.advanceTimersByTime(120_001);
      await lock.renew();
      expect(lost).toEqual([expect.stringMatching(/not renewed in time/)]);
      expect(await heldRecord(`${file}.lock`)).toEqual(before);
      await lock.release();
    });

    it('treats a symlinked or junctioned alias of the state directory as the same store', async () => {
      directory = await mkdtemp(join(tmpdir(), 'xenon-instance-lock-alias-'));
      const real = join(directory, 'real');
      const alias = join(directory, 'alias');
      await mkdir(real);
      await symlink(real, alias, 'junction');
      const lock = await acquireRuntimeInstanceLock(join(real, 'discord-runtime.json'));
      await expect(acquireRuntimeInstanceLock(join(alias, 'discord-runtime.json'))).rejects.toThrow(
        /Another Xenon Discord runtime/,
      );
      await lock.release();
    });
  });
});
