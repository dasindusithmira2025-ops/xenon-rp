import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, type GuildMember } from 'discord.js';

import { prisma } from '@xenon/database';
import { XenonBasePanel } from '@xenon/discord';
import { enqueueBestEffort } from '@xenon/jobs';

import { botEnv, logger } from '../runtime';

function link(path: string): string | null {
  const site = new URL(botEnv.NEXT_PUBLIC_SITE_URL);
  if (
    botEnv.NODE_ENV === 'production' &&
    (site.hostname === 'localhost' || site.hostname === '127.0.0.1')
  ) {
    return null;
  }
  return new URL(path, site).toString();
}

function welcomeButtons(): ActionRowBuilder<ButtonBuilder>[] {
  const buttons = [
    ['OPEN XENON', link('/')],
    ['APPLY NOW', link('/applications')],
  ] as const;
  const available = buttons.flatMap(([label, href]) =>
    href === null
      ? []
      : [new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(href)],
  );
  return available.length === 0
    ? []
    : [new ActionRowBuilder<ButtonBuilder>().addComponents(available)];
}

const whitelistLabels: Record<string, string> = {
  NONE: 'NOT STARTED',
  PENDING: 'UNDER REVIEW',
  APPROVED: 'APPROVED',
  SUSPENDED: 'SUSPENDED',
  REVOKED: 'NOT APPROVED',
};

/** Join event. Personal account details are only included in a private DM. */
export async function handleMemberJoin(member: GuildMember): Promise<void> {
  if (botEnv.DISCORD_GUILD_ID === undefined || member.guild.id !== botEnv.DISCORD_GUILD_ID) return;

  const settings = await prisma.systemSetting.findMany({
    where: { key: { startsWith: 'discord.welcome.' } },
    select: { key: true, value: true },
  });
  const value = (key: string): unknown => settings.find((entry) => entry.key === key)?.value;
  const enabled = value('discord.welcome.enabled') === true;
  const publicEnabled = value('discord.welcome.publicEnabled') === true;
  const dmEnabled = value('discord.welcome.dmEnabled') === true;
  const channelValue = value('discord.welcome.channelId');
  const channelId = typeof channelValue === 'string' ? channelValue : null;
  const personalized = value('discord.welcome.personalized') === true;
  const initialRoleValue = value('discord.welcome.initialRoleKey');
  const deleteValue = value('discord.welcome.deleteAfterSeconds');
  const deleteAfterSeconds =
    typeof deleteValue === 'number' && deleteValue > 0
      ? Math.min(Math.floor(deleteValue), 604_800)
      : 0;

  if (!enabled) return;

  if (initialRoleValue === 'role.citizen') {
    const entry = await prisma.discordManagedResource.findUnique({
      where: { guildId_logicalKey: { guildId: member.guild.id, logicalKey: 'role.citizen' } },
      select: { discordResourceId: true, managed: true },
    });
    const role =
      entry?.managed === true && entry.discordResourceId !== null
        ? await member.guild.roles.fetch(entry.discordResourceId).catch(() => null)
        : null;
    if (role !== null && !role.managed && role.permissions.bitfield === 0n) {
      await member.roles.add(role, 'Xenon configured initial role');
    } else {
      logger.warn({ guildId: member.guild.id }, 'Skipped unsafe or unavailable Xenon initial role');
    }
  }

  if (publicEnabled && channelId !== null) {
    const channel = await member.guild.channels.fetch(channelId).catch(() => null);
    if (channel?.isSendable() === true) {
      const content = [
        `WELCOME TO XENON, <@${member.id}>.`,
        'Your story starts here.',
        '',
        'Start with #rules, #how-to-join and #whitelist-info.',
      ].join('\n');
      const message = await channel.send({
        content,
        embeds: [
          XenonBasePanel({
            title: 'WELCOME TO XENON',
            description: 'One city. Thousands of stories.',
            footer: 'XenonRP • Welcome',
          }).toJSON(),
        ],
        components: welcomeButtons(),
        allowedMentions: { users: [member.id], roles: [], parse: [] },
      });
      if (deleteAfterSeconds > 0) {
        await enqueueBestEffort(
          'discord.welcome.delete',
          { channelId: message.channelId, messageId: message.id },
          { delayMs: deleteAfterSeconds * 1_000 },
        );
      }
    }
  }

  if (dmEnabled) {
    const linked = await prisma.discordAccount.findUnique({
      where: { discordId: member.id },
      select: {
        user: { select: { publicId: true, whitelistState: true } },
      },
    });
    const embed = XenonBasePanel({
      title: 'WELCOME TO XENON.',
      description:
        'Your story starts here. Read the rules, link FiveM and apply when you are ready.',
      footer: 'XenonRP • Welcome',
    });
    if (personalized && linked !== null) {
      embed.addFields(
        { name: 'XENON ID', value: linked.user.publicId, inline: true },
        {
          name: 'WHITELIST',
          value: whitelistLabels[linked.user.whitelistState] ?? 'UNDER REVIEW',
          inline: true,
        },
      );
    }
    try {
      await member.send({ embeds: [embed], components: welcomeButtons() });
    } catch (error) {
      logger.debug({ err: error, discordId: member.id }, 'Welcome DM could not be delivered');
    }
  }
}

export const welcomeEvent = Events.GuildMemberAdd;
