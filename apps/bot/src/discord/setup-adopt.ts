import { ChannelType, type Guild } from 'discord.js';

import { prisma } from '@xenon/database';
import {
  adoptExistingResources,
  blueprintFeatures,
  buildDesiredState,
  loadDepartmentInputs,
  loadOrganizationSpaces,
  type AdoptionChannel,
  type AdoptionPlan,
  type AdoptionRole,
  type DesiredState,
} from '@xenon/discord/provisioning';
import type { Actor } from '@xenon/permissions';

const channelKindByType = new Map<number, AdoptionChannel['kind']>([
  [ChannelType.GuildCategory, 'category'],
  [ChannelType.GuildText, 'text'],
  [ChannelType.GuildAnnouncement, 'announcement'],
  [ChannelType.GuildForum, 'forum'],
  [ChannelType.GuildVoice, 'voice'],
]);

/** Reads only the live guild's roles and channels. No provisioning adapter APIs run here. */
export async function adoptGuildResources(
  guild: Guild,
  actor: Actor,
): Promise<{ readonly plan: AdoptionPlan; readonly state: DesiredState }> {
  const [features, departments, organizations, liveChannels, liveRoles] = await Promise.all([
    blueprintFeatures(prisma),
    loadDepartmentInputs(prisma),
    loadOrganizationSpaces(prisma, guild.id),
    guild.channels.fetch(),
    guild.roles.fetch(),
  ]);

  const state = buildDesiredState({
    features,
    guildFeatures: guild.features,
    departments,
    organizations,
    assets: [],
  });
  const channels = [...liveChannels.values()].flatMap((channel) => {
    if (channel === null || channel.isThread()) return [];
    const kind = channelKindByType.get(channel.type);
    return kind === undefined ? [] : [{ id: channel.id, name: channel.name, kind }];
  });
  const roles: AdoptionRole[] = [...liveRoles.values()].map((role) => ({
    id: role.id,
    name: role.name,
    managed: role.managed,
  }));

  const plan = await adoptExistingResources(prisma, actor, {
    guildId: guild.id,
    guildName: guild.name,
    state,
    channels,
    roles,
  });
  return { plan, state };
}
