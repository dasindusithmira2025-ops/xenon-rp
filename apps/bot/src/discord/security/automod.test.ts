import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Collection, type Guild } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { JsonDiscordRuntimeStore } from '../runtime-store';

import { synchronizeAutoModRules } from './automod';

const guildId = '12345678901234567';

function fakeGuild() {
  let sequence = 90000000000000100n;
  const rules = new Collection<
    string,
    { id: string; name: string; triggerType: number; enabled: boolean }
  >();
  const create = vi.fn(
    (options: {
      readonly name: string;
      readonly triggerType: number;
      readonly enabled?: boolean;
      readonly triggerMetadata?: {
        readonly mentionTotalLimit?: number;
        readonly keywordFilter?: readonly string[];
        readonly regexPatterns?: readonly string[];
      };
      readonly actions?: readonly {
        readonly type: number;
        readonly metadata?: { readonly channel?: string };
      }[];
    }) => {
      sequence += 1n;
      const rule = {
        id: String(sequence),
        name: options.name,
        triggerType: options.triggerType,
        enabled: options.enabled ?? true,
      };
      rules.set(rule.id, rule);
      return Promise.resolve(rule);
    },
  );
  const edit = vi.fn(
    (id: string, options: { name: string; triggerType?: number; enabled?: boolean }) => {
      const previous = rules.get(id);
      if (previous === undefined) throw new Error(`Missing mocked AutoMod rule ${id}.`);
      const updated = { ...previous, ...options };
      rules.set(id, updated);
      return Promise.resolve(updated);
    },
  );
  return {
    guild: {
      id: guildId,
      autoModerationRules: {
        fetch: vi.fn(() => Promise.resolve(new Collection([...rules.entries()]))),
        create,
        edit,
      },
    } as unknown as Guild,
    rules,
    create,
    edit,
  };
}

describe('Xenon-owned AutoMod reconciliation', () => {
  let directory = '';

  afterEach(async () => {
    if (directory !== '') await rm(directory, { recursive: true, force: true });
    directory = '';
  });

  it('creates once, then updates only persisted Xenon-owned rule IDs', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-automod-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = fakeGuild();
    const first = await synchronizeAutoModRules(fake.guild, store);
    expect(first.created).toEqual([
      'XENON | Mention Spam',
      'XENON | Invite Protection',
      'XENON | Security Keywords',
    ]);
    const second = await synchronizeAutoModRules(fake.guild, store);
    expect(second.updated).toHaveLength(3);
    expect(fake.create).toHaveBeenCalledTimes(3);
    expect(fake.edit).toHaveBeenCalledTimes(3);
    expect((await store.getGuild(guildId)).security.config.ownedAutoModRuleIds).toHaveLength(3);
  });

  it('serializes concurrent guild reconciliations without orphaning created rules', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-automod-concurrent-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = fakeGuild();
    const results = await Promise.all([
      synchronizeAutoModRules(fake.guild, store),
      synchronizeAutoModRules(fake.guild, store),
    ]);

    expect(fake.create).toHaveBeenCalledTimes(3);
    expect(fake.rules.size).toBe(3);
    expect(new Set([...fake.rules.values()].map((rule) => rule.name)).size).toBe(3);
    const ownedIds = (await store.getGuild(guildId)).security.config.ownedAutoModRuleIds;
    expect(ownedIds).toHaveLength(3);
    expect(ownedIds.every((id) => fake.rules.has(id))).toBe(true);
    expect(results.filter((result) => result.created.length > 0)).toHaveLength(1);
  });

  it('leaves a same-name rule untouched when Xenon ownership is not recorded', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-automod-collision-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = fakeGuild();
    fake.rules.set('90000000000000001', {
      id: '90000000000000001',
      name: 'XENON | Mention Spam',
      triggerType: 1,
      enabled: false,
    });
    const result = await synchronizeAutoModRules(fake.guild, store);
    expect(fake.edit).not.toHaveBeenCalled();
    expect(fake.rules.get('90000000000000001')?.enabled).toBe(false);
    expect(result.conflicts).toEqual(
      expect.arrayContaining([expect.stringContaining('ownership is not recorded')]),
    );
  });

  it('builds rules from the latest persisted security configuration', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-automod-config-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const auditChannelId = '12345678901234568';
    await store.updateGuild(guildId, (current) => ({
      ...current,
      security: {
        ...current.security,
        config: {
          ...current.security.config,
          prohibitedKeywords: ['spoofed-payment'],
          channels: { ...current.security.config.channels, audit: auditChannelId },
        },
      },
    }));
    const fake = fakeGuild();

    await synchronizeAutoModRules(fake.guild, store);

    const keywordRule = fake.create.mock.calls
      .map(([options]) => options)
      .find((options) => options.name === 'XENON | Security Keywords');

    expect(keywordRule?.triggerMetadata?.keywordFilter).toContain('spoofed-payment');
    expect(
      keywordRule?.actions?.some((action) => action.metadata?.channel === auditChannelId),
    ).toBe(true);
  });
});
