import { describe, expect, it } from 'vitest';

import { planResourceAdoption } from './adoption';
import { buildDesiredState } from './blueprint';
import { blueprintContext, FakeGuild } from './testing';

import type { AdoptionChannel } from './adoption';
import type { RegistryEntry } from './types';

const state = buildDesiredState(blueprintContext());

function registryEntry(
  logicalKey: string,
  resourceType: RegistryEntry['resourceType'],
  discordId: string | null,
): RegistryEntry {
  return {
    logicalKey,
    resourceType,
    discordId,
    channelId: null,
    managed: true,
    contentHash: null,
    configurationHash: null,
    createdByRunId: null,
    metadata: {},
  };
}

function liveChannels(guild: FakeGuild): AdoptionChannel[] {
  return [...guild.channels.values()].flatMap(({ id, name, kind }) =>
    kind === 'other' ? [] : [{ id, name, kind }],
  );
}

function liveRoles(guild: FakeGuild) {
  return [...guild.roles.values()].map(({ id, name, managed }) => ({ id, name, managed }));
}

describe('existing Discord resource adoption matching', () => {
  it('adopts one exact normalized-name channel without calling Discord mutation APIs', () => {
    const guild = new FakeGuild();
    const id = guild.addChannel({
      name: 'announcements',
      kind: 'text',
      parentId: null,
      topic: null,
    });

    const result = planResourceAdoption(state, [], liveChannels(guild), liveRoles(guild));

    expect(result.adopted).toContainEqual(
      expect.objectContaining({ logicalKey: 'channel.announcements', discordId: id }),
    );
    expect(guild.calls).toEqual([]);
  });

  it('does not adopt a same-name resource with an incompatible channel type', () => {
    const guild = new FakeGuild();
    guild.addChannel({ name: 'welcome', kind: 'voice', parentId: null, topic: null });

    const result = planResourceAdoption(state, [], liveChannels(guild), liveRoles(guild));

    expect(result.adopted.some((item) => item.logicalKey === 'channel.welcome')).toBe(false);
    expect(result.missing).toContainEqual({ logicalKey: 'channel.welcome', name: 'welcome' });
  });

  it('skips exact matches when more than one compatible channel exists', () => {
    const guild = new FakeGuild();
    guild.addChannel({ name: 'welcome', kind: 'text', parentId: null, topic: null });
    guild.addChannel({ name: 'WELCOME', kind: 'text', parentId: null, topic: null });

    const result = planResourceAdoption(state, [], liveChannels(guild), liveRoles(guild));

    expect(result.adopted.some((item) => item.logicalKey === 'channel.welcome')).toBe(false);
    expect(result.ambiguous).toContainEqual(
      expect.objectContaining({ logicalKey: 'channel.welcome', matches: 2 }),
    );
  });

  it('preserves a registered resource id even when another exact-name resource exists', () => {
    const guild = new FakeGuild();
    const registeredId = guild.addChannel({
      name: 'old-welcome',
      kind: 'text',
      parentId: null,
      topic: null,
    });
    const unregisteredId = guild.addChannel({
      name: 'welcome',
      kind: 'text',
      parentId: null,
      topic: null,
    });

    const result = planResourceAdoption(
      state,
      [registryEntry('channel.welcome', 'CHANNEL', registeredId)],
      liveChannels(guild),
      liveRoles(guild),
    );

    expect(result.adopted.some((item) => item.logicalKey === 'channel.welcome')).toBe(false);
    expect(result.alreadyMapped).toContainEqual(
      expect.objectContaining({ logicalKey: 'channel.welcome', discordId: registeredId }),
    );
    expect(
      result.alreadyMapped.find((item) => item.logicalKey === 'channel.welcome')?.discordId,
    ).not.toBe(unregisteredId);
  });
});
