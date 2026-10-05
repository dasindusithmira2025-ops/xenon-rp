import {
  type ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';

import {
  approveApplication,
  getOwnApplication,
  listReviewQueue,
  rejectApplication,
  requestChanges,
  statusLabels,
} from '@xenon/applications';
import { brand } from '@xenon/config';
import { toSafeMessage } from '@xenon/core';
import { prisma } from '@xenon/database';
import { buildStatusEmbed, XenonAnnouncementPanel } from '@xenon/discord';
import { findUserByReference, statusBoard } from '@xenon/domain';
import { redeemLinkCode } from '@xenon/fivem';
import { can } from '@xenon/permissions';
import { linkCodeInput } from '@xenon/validation';

import { botEnv, logger } from '../runtime';

import { actorFromDiscord } from './actor';
import { handleXenonCommand, xenonCommand } from './setup-command';
import { handleRoomCommand, roomCommand } from './temp-voice';

/**
 * Slash commands.
 *
 * Only commands that correspond to real behaviour exist. There is no `/help`
 * that lists commands the bot does not have and no `/ping`; a command that
 * does nothing useful is noise in every member's autocomplete.
 *
 * Every staff command resolves an `Actor` from the database and calls the same
 * service the website calls, so `/approve` and clicking Approve in /control are
 * the same operation with the same audit entry, differing only in `source`.
 */

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show whether the city is online')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Show your Xenon account, or somebody else’s')
    .addUserOption((option) =>
      option.setName('member').setDescription('Whose profile to show').setRequired(false),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Redeem a FiveM link code from your portal')
    .addStringOption((option) =>
      option.setName('code').setDescription('For example XEN-7K4P9').setRequired(true),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('application')
    .setDescription('Show one of your applications')
    .addStringOption((option) =>
      option.setName('reference').setDescription('For example XN-WL-1842').setRequired(false),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Staff: show the applications waiting for review')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('review')
    .setDescription('Staff: bring up one application')
    .addStringOption((option) =>
      option.setName('reference').setDescription('For example XN-WL-1842').setRequired(true),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('player')
    .setDescription('Staff: look up a player')
    .addStringOption((option) =>
      option
        .setName('reference')
        .setDescription('Xenon ID, Discord ID or display name')
        .setRequired(true),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('announce')
    .setDescription('Post an announcement to Xenon announcements')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((option) =>
      option
        .setName('title')
        .setDescription('Announcement title')
        .setRequired(true)
        .setMaxLength(100),
    )
    .addStringOption((option) =>
      option
        .setName('message')
        .setDescription('Announcement message')
        .setRequired(true)
        .setMaxLength(3500),
    )
    .toJSON(),

  xenonCommand,
  roomCommand,
];

type Handler = (interaction: ChatInputCommandInteraction) => Promise<void>;

/** Ephemeral by default: a slash command reply is for the person who ran it. */
function reply(interaction: ChatInputCommandInteraction, content: string): Promise<unknown> {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

const handlers: Record<string, Handler> = {
  xenon: handleXenonCommand,
  room: handleRoomCommand,
  announce: handleAnnouncementCommand,

  async status(interaction) {
    const [board, settings] = await Promise.all([
      statusBoard(prisma),
      prisma.systemSetting.findUnique({ where: { key: 'community.connectUrl' } }),
    ]);

    const connect =
      typeof settings?.value === 'string' && settings.value.length > 0 ? settings.value : null;

    await interaction.reply({
      embeds: [
        buildStatusEmbed({
          aggregate: board.aggregate,
          servers: board.servers.map((server) => ({
            name: server.name,
            state: server.state,
            playerCount: server.playerCount,
            maxPlayers: server.maxPlayers,
            queueLength: server.queueLength,
          })),
          checkedAt: board.checkedAt,
          connectUrl: connect,
        }),
      ],
    });
  },

  async profile(interaction) {
    const target = interaction.options.getUser('member') ?? interaction.user;
    const actor = await actorFromDiscord(interaction.user.id);

    // Looking at your own profile needs nothing; looking at somebody else's is
    // a staff action.
    if (target.id !== interaction.user.id && !can(actor, 'players.view')) {
      await reply(interaction, 'You can only look up your own profile.');
      return;
    }

    const account = await prisma.discordAccount.findUnique({
      where: { discordId: target.id },
      select: {
        user: {
          select: {
            publicId: true,
            displayName: true,
            createdAt: true,
            whitelistState: true,
            status: true,
            _count: { select: { characters: true, submissions: true } },
            gameIdentities: { where: { unlinkedAt: null }, select: { id: true } },
          },
        },
      },
    });

    if (account === null) {
      await reply(
        interaction,
        target.id === interaction.user.id
          ? `You do not have a ${brand.name} account yet. Sign in at ${botEnv.NEXT_PUBLIC_SITE_URL} with Discord.`
          : 'That member has no Xenon account.',
      );
      return;
    }

    const user = account.user;

    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      embeds: [
        new EmbedBuilder()
          .setColor(brand.greenInt)
          .setAuthor({ name: `${brand.shortName} · Profile` })
          .setTitle(user.displayName ?? user.publicId)
          .addFields(
            { name: 'Xenon ID', value: user.publicId, inline: true },
            {
              name: 'Whitelist',
              value: user.whitelistState.toLowerCase(),
              inline: true,
            },
            { name: 'Account', value: user.status.toLowerCase(), inline: true },
            {
              name: 'FiveM',
              value: user.gameIdentities.length > 0 ? 'linked' : 'not linked',
              inline: true,
            },
            { name: 'Characters', value: String(user._count.characters), inline: true },
            { name: 'Applications', value: String(user._count.submissions), inline: true },
          )
          .setFooter({ text: `Joined ${user.createdAt.toDateString()}` }),
      ],
    });
  },

  async link(interaction) {
    const raw = interaction.options.getString('code', true);
    const parsed = linkCodeInput.safeParse(raw);

    if (!parsed.success) {
      await reply(interaction, 'Link codes look like `XEN-7K4P9`. Check the portal and try again.');
      return;
    }

    // Deliberately not restricted to the Discord user who generated it: the
    // code proves possession, and the portal session proved identity when it
    // was issued. Requiring both would break linking from a second device.
    try {
      const result = await redeemLinkCode(prisma, {
        code: parsed.data,
        identifiers: [{ kind: 'DISCORD', value: interaction.user.id }],
        playerName: interaction.user.username,
      });

      await reply(
        interaction,
        `Linked to **${result.displayName ?? result.publicId}** (${result.publicId}). ` +
          'Connect to the city and run `/link` in game to attach your FiveM identifiers too.',
      );
    } catch (error) {
      await reply(interaction, toSafeMessage(error));
    }
  },

  async application(interaction) {
    const actor = await actorFromDiscord(interaction.user.id);
    if (actor.userId === null) {
      await reply(interaction, `Sign in at ${botEnv.NEXT_PUBLIC_SITE_URL} first.`);
      return;
    }

    const reference = interaction.options.getString('reference');

    const submission = await getOwnApplication(prisma, actor, reference ?? undefined);

    if (submission === null) {
      await reply(interaction, 'No application found. Start one on the website.');
      return;
    }

    await reply(
      interaction,
      `**${submission.template.name}** — ${submission.publicId}\n` +
        `Status: ${statusLabels[submission.status]}\n` +
        `${botEnv.NEXT_PUBLIC_SITE_URL}/portal/applications/${submission.publicId}`,
    );
  },

  async queue(interaction) {
    const actor = await actorFromDiscord(interaction.user.id);
    if (!can(actor, 'applications.view')) {
      await reply(interaction, 'You do not have permission to see the review queue.');
      return;
    }

    const { items, total } = await listReviewQueue(prisma, actor, { take: 10 });

    if (items.length === 0) {
      await reply(interaction, 'The queue is clear.');
      return;
    }

    const lines = items.map((submission) => {
      const waited =
        submission.submittedAt === null
          ? '—'
          : `${String(Math.floor((Date.now() - submission.submittedAt.getTime()) / 3_600_000))}h`;
      const who = submission.applicant.displayName ?? submission.applicant.publicId;
      return `\`${submission.publicId}\` ${who} · ${submission.template.name} · waiting ${waited}`;
    });

    await reply(
      interaction,
      `**${String(total)} waiting**\n${lines.join('\n')}\n\n${botEnv.NEXT_PUBLIC_SITE_URL}/control/applications`,
    );
  },

  async review(interaction) {
    const actor = await actorFromDiscord(interaction.user.id);
    if (!can(actor, 'applications.view')) {
      await reply(interaction, 'You do not have permission to review applications.');
      return;
    }

    const reference = interaction.options.getString('reference', true).toUpperCase();
    const submission = await prisma.applicationSubmission.findUnique({
      where: { publicId: reference },
      select: { id: true },
    });

    if (submission === null) {
      await reply(interaction, `No application called ${reference}.`);
      return;
    }

    // Re-posting the card is the useful answer: it brings the buttons back into
    // the channel where the conversation is happening.
    const { postOrUpdateReviewCard } = await import('./review-card');
    if (interaction.client.isReady()) {
      await postOrUpdateReviewCard(interaction.client, submission.id);
    }

    await reply(interaction, `Refreshed the card for ${reference}.`);
  },

  async player(interaction) {
    const actor = await actorFromDiscord(interaction.user.id);
    if (!can(actor, 'players.view')) {
      await reply(interaction, 'You do not have permission to look players up.');
      return;
    }

    const reference = interaction.options.getString('reference', true);
    const user = await findUserByReference(prisma, reference);

    if (user === null) {
      await reply(interaction, `Nothing matched "${reference}".`);
      return;
    }

    await reply(
      interaction,
      `**${user.displayName ?? user.publicId}** (${user.publicId})\n` +
        `Whitelist: ${user.whitelistState.toLowerCase()} · Account: ${user.status.toLowerCase()}\n` +
        `${botEnv.NEXT_PUBLIC_SITE_URL}/control/players/${user.publicId}`,
    );
  },
};

export async function handleAnnouncementCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (interaction.guild === null || interaction.guildId === null) {
    await reply(interaction, 'Use this command in the Xenon Discord server.');
    return;
  }
  if (
    interaction.guild.ownerId !== interaction.user.id &&
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) !== true
  ) {
    await reply(
      interaction,
      'Only the Discord server owner or a member with Manage Server can post announcements.',
    );
    return;
  }

  const configured = await prisma.discordGuild.findUnique({
    where: { guildId: interaction.guildId },
    select: { announcementChannelId: true },
  });
  const channelId = configured?.announcementChannelId;
  const channel =
    channelId === null || channelId === undefined
      ? null
      : await interaction.guild.channels.fetch(channelId).catch(() => null);
  const me = await interaction.guild.members.fetchMe();
  const permissions = channel?.permissionsFor(me);
  if (
    channel?.isTextBased() !== true ||
    !('send' in channel) ||
    permissions?.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]) !== true
  ) {
    await reply(
      interaction,
      'The configured announcements channel is unavailable or Xenon cannot post there. Run `/xenon setup adopt` after checking the channel.',
    );
    return;
  }

  const embed = XenonAnnouncementPanel({
    type: 'COMMUNITY',
    title: interaction.options.getString('title', true),
    message: interaction.options.getString('message', true),
  });
  await channel.send({ embeds: [embed.toJSON()], allowedMentions: { parse: [] } });
  await reply(interaction, 'Announcement posted.');
}

/** Dispatch a slash command. Errors never leak internal detail to a channel. */
export async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const handler = handlers[interaction.commandName];
  if (handler === undefined) {
    await reply(interaction, 'That command is no longer available.');
    return;
  }

  try {
    await handler(interaction);
  } catch (error) {
    logger.error({ err: error, command: interaction.commandName }, 'Command failed');

    const message = toSafeMessage(error);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    }
  }
}

// Re-exported so the interaction router can share the decision services without
// importing the whole command surface.
export { approveApplication, rejectApplication, requestChanges };
