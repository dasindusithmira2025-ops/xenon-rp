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

const integrationLabels = {
  announcementChannel: 'Announcements',
  logChannel: 'Logs',
  reviewChannel: 'Review',
} as const;

export function adoptionReply(
  plan: AdoptionPlan & { readonly roleMappingsSkipped?: number },
  state: DesiredState,
): string {
  const matches = [...plan.adopted, ...plan.alreadyMapped];
  const integrationLines = Object.entries(integrationLabels).map(([key, label]) => {
    const mapping = matches.find((match) => match.integration === key);
    return `${label} → ${mapping === undefined ? 'not mapped' : `#${mapping.name}`}`;
  });
  const criticalKeys = new Set(
    state.channels
      .filter(
        (channel) =>
          channel.critical === true ||
          [
            'channel.welcome',
            'channel.rules',
            'channel.announcements',
            'channel.whitelist-review',
            'channel.bot-ops',
          ].includes(channel.key),
      )
      .map((channel) => channel.key),
  );
  const criticalRoleKeys = new Set(
    state.roles
      .filter((role) => role.tier === 'management' || role.tier === 'staff')
      .map((role) => role.key),
  );
  const attention = [
    ...plan.missing
      .filter((item) => criticalKeys.has(item.logicalKey) || criticalRoleKeys.has(item.logicalKey))
      .map((item) => `Missing ${resourceLabel(item.logicalKey, item.name)}`),
    ...plan.ambiguous
      .filter((item) => criticalKeys.has(item.logicalKey) || criticalRoleKeys.has(item.logicalKey))
      .map(
        (item) =>
          `Ambiguous ${resourceLabel(item.logicalKey, item.name)} (${String(item.matches)} matches)`,
      ),
  ].slice(0, 8);
  const announcementReady = matches.some((match) => match.integration === 'announcementChannel');

  return [
    'XENON EXISTING SERVER ADOPTED',
    '',
    `Adopted: ${String(plan.adopted.length)}`,
    `Already mapped: ${String(plan.alreadyMapped.length)}`,
    `Missing: ${String(plan.missing.length)}`,
    `Ambiguous: ${String(plan.ambiguous.length)}`,
    ...(plan.roleMappingsSkipped === undefined || plan.roleMappingsSkipped === 0
      ? []
      : [`Role mapping conflicts preserved: ${String(plan.roleMappingsSkipped)}`]),
    '',
    'Integrations:',
    ...integrationLines,
    ...(attention.length === 0 ? [] : ['', 'Critical resources needing attention:', ...attention]),
    ...(announcementReady ? ['', '/announce is ready.'] : []),
    '',
    'No Discord resources were created or modified.',
  ].join('\n');
}

function resourceLabel(logicalKey: string, name: string): string {
  return logicalKey.startsWith('role.') ? `@${name}` : `#${name}`;
}
