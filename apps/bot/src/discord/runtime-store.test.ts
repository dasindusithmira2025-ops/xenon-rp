import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { JsonDiscordRuntimeStore } from './runtime-store';

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
    await first.saveWelcome(guildId, { welcomeEnabled: true, welcomeDmEnabled: true });
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
    expect(state.welcomeDmEnabled).toBe(true);
    expect(state.entries[0]?.logicalKey).toBe('panel.welcome');
    expect(state.rooms[roomId]?.ownerId).toBe('42345678901234567');
  });

  it('never writes secrets and rejects sensitive registry metadata', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-runtime-'));
    const file = join(directory, 'discord-runtime.json');
    const store = new JsonDiscordRuntimeStore(file);
    await expect(store.registry(guildId).upsert({
      logicalKey: 'panel.welcome',
      resourceType: 'PANEL',
      discordId: roomId,
      channelId: '32345678901234567',
      managed: true,
      contentHash: null,
      configurationHash: null,
      createdByRunId: null,
      metadata: { token: 'must-never-be-written' },
    })).rejects.toThrow(/Sensitive field/);
    await store.saveWelcome(guildId, { welcomeEnabled: true, welcomeDmEnabled: false });
    const contents = await readFile(file, 'utf8');
    expect(contents).not.toMatch(/token|secret|password|database|redis|auth/i);
    expect(contents).not.toContain('must-never-be-written');
    expect((await readdir(directory)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });
});
