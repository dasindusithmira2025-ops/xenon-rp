import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AutoModerationRuleTriggerType, Collection, DiscordAPIError, type Guild } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { JsonDiscordRuntimeStore } from '../runtime-store';

import { synchronizeAutoModRules } from './automod';

const guildId = '12345678901234567';

function apiError(code: number, message: string): DiscordAPIError {
  return new DiscordAPIError({ code, message }, code, 400, 'POST', 'url', {});
}

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
    expect(first.xenonOwnedRuleCount).toBe(3);
    expect(first.existingServerRules).toEqual([]);
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
      triggerType: AutoModerationRuleTriggerType.MentionSpam,
      enabled: false,
    });
    const result = await synchronizeAutoModRules(fake.guild, store);
    expect(fake.edit).not.toHaveBeenCalled();
    expect(fake.rules.get('90000000000000001')?.enabled).toBe(false);
    expect(result.conflicts).toEqual(
      expect.arrayContaining([expect.stringContaining('ownership is not recorded')]),
    );
    expect(result.skipped).toEqual(
      expect.arrayContaining([expect.stringContaining('XENON | Mention Spam: skipped')]),
    );
  });

  it('preserves a differently named server mention rule and syncs independent rule types', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-automod-mention-limit-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = fakeGuild();
    const existingRule = {
      id: '80000000000000001',
      name: 'Server Mention Guard',
      triggerType: AutoModerationRuleTriggerType.MentionSpam,
      enabled: true,
    };
    fake.rules.set(existingRule.id, existingRule);

    const result = await synchronizeAutoModRules(fake.guild, store);

    expect(fake.rules.get(existingRule.id)).toEqual(existingRule);
    expect(fake.edit).not.toHaveBeenCalled();
    expect(fake.create.mock.calls.map(([options]) => options.name)).toEqual([
      'XENON | Invite Protection',
      'XENON | Security Keywords',
    ]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([expect.stringContaining('XENON | Mention Spam: skipped')]),
    );
    expect(result.conflicts.join(' ')).toContain(existingRule.name);
    expect(result.existingServerRules).toEqual([
      {
        name: existingRule.name,
        triggerType: existingRule.triggerType,
        enabled: existingRule.enabled,
      },
    ]);
    expect(result.xenonOwnedRuleCount).toBe(2);
    expect((await store.getGuild(guildId)).security.config.ownedAutoModRuleIds).toHaveLength(2);
  });

  it('respects the keyword trigger limit while syncing independent mention protection', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-automod-keyword-limit-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = fakeGuild();
    for (let index = 0; index < 5; index += 1) {
      const id = `8000000000000000${String(index + 1)}`;
      fake.rules.set(id, {
        id,
        name: `Server Keyword Rule ${String(index + 1)}`,
        triggerType: AutoModerationRuleTriggerType.Keyword,
        enabled: index !== 0,
      });
    }

    const result = await synchronizeAutoModRules(fake.guild, store);

    expect(fake.create.mock.calls.map(([options]) => options.name)).toEqual([
      'XENON | Mention Spam',
      'XENON | Invite Protection',
    ]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([expect.stringContaining('XENON | Security Keywords: skipped')]),
    );
    expect(result.existingServerRules).toHaveLength(5);
    expect(result.xenonOwnedRuleCount).toBe(2);
  });

  it('continues other rules when Discord rejects one create request', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-automod-create-error-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = fakeGuild();
    fake.create.mockRejectedValueOnce(
      apiError(50_035, 'AUTO_MODERATION_MAX_RULES_OF_TYPE_EXCEEDED'),
    );

    const result = await synchronizeAutoModRules(fake.guild, store);

    expect(result.created).toEqual(['XENON | Invite Protection', 'XENON | Security Keywords']);
    expect(result.skipped.join(' ')).toContain('XENON | Mention Spam');
    expect(result.conflicts.join(' ')).toContain('50035');
    expect((await store.getGuild(guildId)).security.config.ownedAutoModRuleIds).toHaveLength(2);
  });

  it('continues updates and retains ownership when one Discord edit fails', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-automod-edit-error-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = fakeGuild();
    await synchronizeAutoModRules(fake.guild, store);
    fake.edit.mockRejectedValueOnce(apiError(50_013, 'Missing Permissions'));

    const result = await synchronizeAutoModRules(fake.guild, store);

    expect(result.updated).toEqual(['XENON | Invite Protection', 'XENON | Security Keywords']);
    expect(result.skipped.join(' ')).toContain('XENON | Mention Spam');
    expect(result.conflicts.join(' ')).toContain('50013');
    expect((await store.getGuild(guildId)).security.config.ownedAutoModRuleIds).toHaveLength(3);
  });

  it('returns an unavailable result when fetching server rules fails', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xenon-automod-fetch-error-'));
    const store = new JsonDiscordRuntimeStore(join(directory, 'discord-runtime.json'));
    const fake = fakeGuild();
    vi.mocked(fake.guild.autoModerationRules.fetch).mockRejectedValueOnce(
      apiError(50_001, 'Missing Access'),
    );

    const result = await synchronizeAutoModRules(fake.guild, store);

    expect(result.unavailable).toContain('50001');
    expect(result.xenonOwnedRuleCount).toBeNull();
    expect(result.created).toEqual([]);
    expect(fake.create).not.toHaveBeenCalled();
    expect(fake.edit).not.toHaveBeenCalled();
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
