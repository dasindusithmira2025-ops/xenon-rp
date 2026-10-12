import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type InteractionEditReplyOptions,
} from 'discord.js';

import { brand } from '@xenon/config';
import type { CoreOutput } from '@xenon/contracts';
import type { Logger } from '@xenon/logger';

import type { CoreCall, CoreResult } from './core-client';

/**
 * Xenon Link slash commands.
 *
 * Every command is a thin view over one Core API operation: Link resolves no
 * permission itself and holds no data. Core decides who may see what from the
 * database, so `/player` from Discord and the player page in /control apply
 * the same capability check.
 *
 * Each reply is deferred first. Core is a network hop away and Discord gives
 * an interaction three seconds for its first response; deferring buys the
 * full Core timeout without a "This interaction failed" for the member.
 */

export const linkCommands = [
  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Check your Cfx.re (FiveM) link and how to connect it on the website')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Show your Xenon account, or somebody else’s')
    .addUserOption((option) =>
      option.setName('member').setDescription('Whose profile to show').setRequired(false),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('whitelist')
    .setDescription('Show your whitelist status and latest application')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('application')
    .setDescription('Show one of your applications')
    .addStringOption((option) =>
      option
        .setName('reference')
        .setDescription('For example XN-WL-1842')
        .setRequired(false)
        .setMaxLength(64),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show whether the city is online')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('player')
    .setDescription('Staff: look up a player')
    .addStringOption((option) =>
      option
        .setName('reference')
        .setDescription('Xenon ID, Discord ID or display name')
        .setRequired(true)
        .setMaxLength(64),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('review')
    .setDescription('Staff: bring up one application')
    .addStringOption((option) =>
      option
        .setName('reference')
        .setDescription('For example XN-WL-1842')
        .setRequired(true)
        .setMaxLength(64),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('sync')
    .setDescription('Re-sync Discord roles from your Xenon account')
    .addUserOption((option) =>
      option.setName('member').setDescription('Staff: whose roles to sync').setRequired(false),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Staff: show the applications waiting for review')
    .toJSON(),
];

export interface CommandContext {
  readonly core: CoreCall;
  readonly siteUrl: string;
  readonly logger: Logger;
}

type Handler = (interaction: ChatInputCommandInteraction, context: CommandContext) => Promise<void>;

function siteLink(context: CommandContext, path: string): string {
  return new URL(path, context.siteUrl).toString();
}

/** Every reply suppresses mentions: echoed references must never ping anyone. */
async function respond(
  interaction: ChatInputCommandInteraction,
  reply: string | Omit<InteractionEditReplyOptions, 'allowedMentions'>,
): Promise<void> {
  const options = typeof reply === 'string' ? { content: reply } : reply;
  await interaction.editReply({ ...options, allowedMentions: { parse: [] } });
}

/**
 * Unwrap a Core result, replying with Core's safe message on failure.
 * Returns undefined when the failure has already been answered.
 */
async function unwrap<T>(
  interaction: ChatInputCommandInteraction,
  result: CoreResult<T>,
): Promise<T | undefined> {
  if (result.ok) return result.data;
  await respond(interaction, result.error.message);
  return undefined;
}

function signInMessage(context: CommandContext): string {
  return `You do not have a ${brand.name} account yet. Sign in at ${context.siteUrl} with Discord.`;
}

export function buildStatusEmbed(board: CoreOutput<'status.board'>): EmbedBuilder {
  const colour =
    board.aggregate === 'ONLINE'
      ? brand.state.successInt
      : board.aggregate === 'DEGRADED'
        ? brand.state.warningInt
        : board.aggregate === 'OFFLINE'
          ? brand.state.dangerInt
          : brand.state.neutralInt;

  const embed = new EmbedBuilder()
    .setColor(colour)
    .setAuthor({ name: `${brand.wordmark} · City status` })
    .setTitle(
      board.aggregate === 'ONLINE'
        ? 'City online'
        : board.aggregate === 'OFFLINE'
          ? 'City offline'
          : board.aggregate === 'DEGRADED'
            ? 'Partially available'
            : 'Status unavailable',
    );

  if (board.servers.length === 0) {
    embed.setDescription('No game server is configured yet.');
    return embed;
  }

  // "unavailable" rather than a zero: a board that says "0 players" when the
  // poller is broken is worse than one that admits it does not know.
  for (const server of board.servers) {
    const players =
      server.playerCount === null
        ? 'unavailable'
        : `${String(server.playerCount)}${server.maxPlayers === null ? '' : ` / ${String(server.maxPlayers)}`}`;

    embed.addFields({
      name: server.name,
      value: [
        `State: ${server.state.toLowerCase()}`,
        `Players: ${players}`,
        server.queueLength === null || server.queueLength === 0
          ? null
          : `Queue: ${String(server.queueLength)}`,
      ]
        .filter((line): line is string => line !== null)
        .join('\n'),
      inline: true,
    });
  }

  if (board.connectUrl !== null && board.connectUrl.length > 0) {
    embed.addFields({ name: 'Connect', value: board.connectUrl, inline: false });
  }
  if (board.checkedAt !== null) embed.setTimestamp(new Date(board.checkedAt));

  return embed;
}

const handlers: Record<string, Handler> = {
  async link(interaction, context) {
    const status = await unwrap(
      interaction,
      await context.core('link.status', { actorDiscordId: interaction.user.id }),
    );
    if (status === undefined) return;
    if (!status.hasAccount) {
      await respond(interaction, signInMessage(context));
      return;
    }

    const accountPage = siteLink(context, '/portal/account#fivem');
    if (!status.linked) {
      await respond(
        interaction,
        [
          'Your Cfx.re (FiveM) account is not linked yet.',
          `Open ${accountPage} and choose **Connect Cfx.re**. You approve Xenon on forum.cfx.re and come straight back — nothing to type in game.`,
        ].join('\n'),
      );
      return;
    }

    const since =
      status.linkedAt === null
        ? ''
        : ` since <t:${String(Math.floor(new Date(status.linkedAt).getTime() / 1000))}:D>`;
    await respond(
      interaction,
      [
        `Linked to Cfx.re account **${status.cfxUsername ?? 'unknown'}**${since}.`,
        status.verifiedOnWebsite
          ? 'Verified through Cfx.re on the Xenon website.'
          : `Linked by an older method — reconnect it at ${accountPage} to verify it through Cfx.re.`,
        `Manage it at ${accountPage}.`,
      ].join('\n'),
    );
  },

  async profile(interaction, context) {
    const target = interaction.options.getUser('member') ?? interaction.user;
    const self = target.id === interaction.user.id;
    const profile = await unwrap(
      interaction,
      await context.core('players.profile', {
        actorDiscordId: interaction.user.id,
        targetDiscordId: target.id,
      }),
    );
    if (profile === undefined) return;

    if (profile === null) {
      await respond(
        interaction,
        self ? signInMessage(context) : 'That member has no Xenon account.',
      );
      return;
    }

    await respond(interaction, {
      embeds: [
        new EmbedBuilder()
          .setColor(brand.greenInt)
          .setAuthor({ name: `${brand.shortName} · Profile` })
          .setTitle(profile.displayName ?? profile.publicId)
          .addFields(
            { name: 'Xenon ID', value: profile.publicId, inline: true },
            { name: 'Whitelist', value: profile.whitelistState.toLowerCase(), inline: true },
            { name: 'Account', value: profile.accountStatus.toLowerCase(), inline: true },
            {
              name: 'Cfx.re',
              value: profile.fivemLinked ? (profile.cfxUsername ?? 'linked') : 'not linked',
              inline: true,
            },
            { name: 'Characters', value: String(profile.characters), inline: true },
            { name: 'Applications', value: String(profile.applications), inline: true },
          )
          .setFooter({ text: `Joined ${new Date(profile.joinedAt).toDateString()}` }),
      ],
    });
  },

  async whitelist(interaction, context) {
    const status = await unwrap(
      interaction,
      await context.core('whitelist.status', { actorDiscordId: interaction.user.id }),
    );
    if (status === undefined) return;
    if (!status.hasAccount) {
      await respond(interaction, signInMessage(context));
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(brand.greenInt)
      .setAuthor({ name: `${brand.shortName} · Whitelist` })
      .setTitle(status.state === null ? 'No whitelist yet' : status.state.toLowerCase())
      .addFields({
        name: 'Cfx.re',
        value: status.fivemLinked
          ? 'linked'
          : `not linked — connect it at ${siteLink(context, '/portal/account#fivem')}`,
        inline: true,
      });
    if (status.reason !== null && status.reason.length > 0) {
      embed.addFields({ name: 'Reason', value: status.reason.slice(0, 1024), inline: false });
    }
    const latest = status.latestApplication;
    embed.addFields({
      name: 'Latest application',
      value:
        latest === null
          ? `None yet. Apply at ${siteLink(context, '/applications')}`
          : `${latest.reference} — ${latest.statusLabel}\n${siteLink(context, `/portal/applications/${latest.reference}`)}`,
      inline: false,
    });
    embed.setURL(siteLink(context, '/portal'));
    await respond(interaction, { embeds: [embed] });
  },

  async application(interaction, context) {
    const reference = interaction.options.getString('reference');
    const application = await unwrap(
      interaction,
      await context.core('applications.own', {
        actorDiscordId: interaction.user.id,
        ...(reference === null ? {} : { reference }),
      }),
    );
    if (application === undefined) return;
    if (application === null) {
      await respond(interaction, 'No application found. Start one on the website.');
      return;
    }
    await respond(
      interaction,
      `**${application.templateName}** — ${application.reference}\n` +
        `Status: ${application.statusLabel}\n` +
        siteLink(context, `/portal/applications/${application.reference}`),
    );
  },

  async status(interaction, context) {
    const board = await unwrap(interaction, await context.core('status.board', {}));
    if (board === undefined) return;
    await respond(interaction, { embeds: [buildStatusEmbed(board)] });
  },

  async player(interaction, context) {
    const reference = interaction.options.getString('reference', true);
    const player = await unwrap(
      interaction,
      await context.core('players.lookup', { actorDiscordId: interaction.user.id, reference }),
    );
    if (player === undefined) return;
    if (player === null) {
      await respond(interaction, `Nothing matched "${reference}".`);
      return;
    }
    await respond(
      interaction,
      `**${player.displayName ?? player.publicId}** (${player.publicId})\n` +
        `Whitelist: ${player.whitelistState.toLowerCase()} · Account: ${player.accountStatus.toLowerCase()}\n` +
        siteLink(context, `/control/players/${player.publicId}`),
    );
  },

  async review(interaction, context) {
    const reference = interaction.options.getString('reference', true).trim().toUpperCase();
    const result = await unwrap(
      interaction,
      await context.core('applications.refreshCard', {
        actorDiscordId: interaction.user.id,
        reference,
      }),
    );
    if (result === undefined) return;
    await respond(
      interaction,
      result.queued
        ? `Refreshing the review card for ${reference}.`
        : `${reference} has no review card to refresh.`,
    );
  },

  async sync(interaction, context) {
    const target = interaction.options.getUser('member');
    const result = await unwrap(
      interaction,
      await context.core('roles.sync', {
        actorDiscordId: interaction.user.id,
        ...(target === null ? {} : { targetDiscordId: target.id }),
      }),
    );
    if (result === undefined) return;
    await respond(
      interaction,
      result.queued
        ? `Role sync queued for ${result.playerPublicId}. Roles update within a minute.`
        : `Roles for ${result.playerPublicId} are already up to date.`,
    );
  },

  async queue(interaction, context) {
    const queue = await unwrap(
      interaction,
      await context.core('applications.queue', { actorDiscordId: interaction.user.id }),
    );
    if (queue === undefined) return;
    if (queue.items.length === 0) {
      await respond(interaction, 'The queue is clear.');
      return;
    }

    const now = Date.now();
    const lines = queue.items.map((item) => {
      const waited =
        item.submittedAt === null
          ? '—'
          : `${String(Math.floor((now - new Date(item.submittedAt).getTime()) / 3_600_000))}h`;
      return `\`${item.reference}\` ${item.applicant} · ${item.templateName} · waiting ${waited}`;
    });
    await respond(
      interaction,
      `**${String(queue.total)} waiting**\n${lines.join('\n')}\n\n${siteLink(context, '/control/applications')}`,
    );
  },
};

/** Dispatch a slash command. Errors never leak internal detail to a channel. */
export async function handleCommand(
  interaction: ChatInputCommandInteraction,
  context: CommandContext,
): Promise<void> {
  const handler = handlers[interaction.commandName];
  if (handler === undefined) {
    await interaction.reply({
      content: 'That command is no longer available.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    // `/status` is a public answer; everything else is for the person who asked.
    await interaction.deferReply(
      interaction.commandName === 'status' ? {} : { flags: MessageFlags.Ephemeral },
    );
    await handler(interaction, context);
  } catch (error) {
    context.logger.error({ err: error, command: interaction.commandName }, 'Command failed');
    const content = 'Something went wrong. Try again shortly.';
    if (interaction.deferred || interaction.replied) {
      await interaction
        .editReply({ content, allowedMentions: { parse: [] } })
        .catch(() => undefined);
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
  }
}
