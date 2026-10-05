import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  OverwriteType,
  PermissionFlagsBits as P,
  RESTJSONErrorCodes,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type Message,
  type TextChannel,
  type StringSelectMenuInteraction,
} from 'discord.js';

import { xenonIds } from '@xenon/discord/interaction-ids';
import { XenonBasePanel } from '@xenon/discord/panels';

import { logger } from '../runtime';

import type { DiscordRuntimeStore, TicketConfig, TicketRecord } from './runtime-store';

/**
 * Discord-only support tickets.
 *
 * Every infrastructure resource (panel channel, category, log channel, staff
 * role) already exists and is chosen by management with `/xenon tickets
 * publish`; this module only stores their ids. The only things it ever creates
 * are the panel message and one private text channel per ticket.
 */

export const TICKET_CATEGORIES = [
  { value: 'GENERAL', label: 'General Support', description: 'Questions and general help' },
  { value: 'TECHNICAL', label: 'Technical Support', description: 'Connection, game or Discord problems' },
  { value: 'WHITELIST', label: 'Whitelist Support', description: 'Whitelist or application help' },
  { value: 'PLAYER_REPORT', label: 'Player Report', description: 'Report a player or rule violation' },
  { value: 'STAFF_REPORT', label: 'Staff Report', description: 'Report a Xenon staff member' },
  { value: 'BUSINESS', label: 'Business / Organization', description: 'Business, gang or organization help' },
  { value: 'OTHER', label: 'Other', description: 'Anything else' },
] as const;

const OWNER_ALLOW = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles];
const STAFF_ALLOW = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageMessages];
const BOT_ALLOW = [
  P.ViewChannel,
  P.SendMessages,
  P.ReadMessageHistory,
  P.EmbedLinks,
  P.AttachFiles,
  P.ManageMessages,
  P.ManageChannels,
];
/** The bot can only grant permissions it holds, and needs Manage Roles to write overwrites. */
const CATEGORY_REQUIRED = [...new Set([...OWNER_ALLOW, ...STAFF_ALLOW, ...BOT_ALLOW, P.ManageRoles])];
const MESSAGE_CHANNEL_REQUIRED = [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ReadMessageHistory];

const CREATE_COOLDOWN_MS = 60_000;
export const RERUN_PUBLISH =
  'Tickets are temporarily unavailable. Xenon management must rerun /xenon tickets publish.';

const lastCreation = new Map<string, number>();
const creating = new Set<string>();

/** Test seam: the per-user creation cooldown is process memory. */
export function resetTicketCooldowns(): void {
  lastCreation.clear();
  creating.clear();
}

export function ticketCenterPanel() {
  const select = new StringSelectMenuBuilder()
    .setCustomId(xenonIds.ticketOpen())
    .setPlaceholder('Choose a category to open a ticket')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(TICKET_CATEGORIES.map(({ value, label, description }) => ({ value, label, description })));
  return {
    embeds: [
      XenonBasePanel({
        title: 'XENON SUPPORT CENTER',
        description:
          'Need assistance? Open a private support ticket below.\nA member of the Xenon staff team will respond as soon as possible.',
        footer: 'XenonRP • Support',
      })
        .addFields({ name: 'CATEGORIES', value: TICKET_CATEGORIES.map((category) => `• ${category.label}`).join('\n') })
        .toJSON(),
    ],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select).toJSON()],
  };
}

function categoryLabel(value: string): string {
  return TICKET_CATEGORIES.find((category) => category.value === value)?.label ?? 'Other';
}

function openedEmbed(ticket: TicketRecord) {
  return XenonBasePanel({
    title: 'XENON SUPPORT · TICKET OPENED',
    description:
      'A member of the Xenon staff team will respond as soon as possible. Describe your issue in as much detail as you can.',
    footer: 'XenonRP • Support',
    timestamp: new Date(ticket.createdAt),
  })
    .addFields(
      { name: 'Ticket', value: ticket.ticketId, inline: true },
      { name: 'Category', value: categoryLabel(ticket.category), inline: true },
      { name: 'Opened by', value: `<@${ticket.ownerId}>`, inline: true },
    )
    .toJSON();
}

function unixTime(iso: string | null): string {
  return iso === null ? 'Unknown' : `<t:${String(Math.floor(new Date(iso).getTime() / 1000))}:F>`;
}

function memberMention(id: string | null): string {
  return id === null ? 'Xenon (channel missing)' : `<@${id}> (${id})`;
}

/** Discord's "resource is gone" answers; any other failure means "unknown", never "missing". */
function isUnknownResource(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  return code === RESTJSONErrorCodes.UnknownChannel || code === RESTJSONErrorCodes.UnknownMessage;
}

// ── /xenon tickets publish ──────────────────────────────────────────────────

const publishing = new Set<string>();

export async function publishTicketPanel(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
  store: DiscordRuntimeStore,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (publishing.has(guild.id)) {
    await interaction.editReply('Another ticket publish is already running. Nothing was changed.');
    return;
  }
  publishing.add(guild.id);
  try {
    await publishSerialized(interaction, guild, store);
  } finally {
    publishing.delete(guild.id);
  }
}

async function publishSerialized(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
  store: DiscordRuntimeStore,
): Promise<void> {
  const [panelChannel, category, logChannel, staffRole] = await Promise.all([
    guild.channels.fetch(interaction.options.getChannel('panel_channel', true).id).catch(() => null),
    guild.channels.fetch(interaction.options.getChannel('ticket_category', true).id).catch(() => null),
    guild.channels.fetch(interaction.options.getChannel('log_channel', true).id).catch(() => null),
    guild.roles.fetch(interaction.options.getRole('staff_role', true).id).catch(() => null),
  ]);

  if (panelChannel?.guildId !== guild.id || panelChannel.type !== ChannelType.GuildText) {
    await interaction.editReply('panel_channel must be an existing text channel in this server. Nothing was saved.');
    return;
  }
  if (category?.guildId !== guild.id || category.type !== ChannelType.GuildCategory) {
    await interaction.editReply('ticket_category must be an existing category in this server. Nothing was saved.');
    return;
  }
  if (logChannel?.guildId !== guild.id || logChannel.type !== ChannelType.GuildText) {
    await interaction.editReply('log_channel must be an existing text channel in this server. Nothing was saved.');
    return;
  }
  if (staffRole?.guild.id !== guild.id || staffRole.id === guild.id) {
    await interaction.editReply('staff_role must be an existing role in this server other than @everyone. Nothing was saved.');
    return;
  }

  const me = await guild.members.fetchMe();
  const missing = [
    ...missingPermissions(category.permissionsFor(me).missing(CATEGORY_REQUIRED), `category ${category.name}`),
    ...missingPermissions(panelChannel.permissionsFor(me).missing(MESSAGE_CHANNEL_REQUIRED), `#${panelChannel.name}`),
    ...missingPermissions(logChannel.permissionsFor(me).missing(MESSAGE_CHANNEL_REQUIRED), `#${logChannel.name}`),
  ];
  if (missing.length > 0) {
    await interaction.editReply(`Xenon is missing permissions. Nothing was saved.\n${missing.join('\n')}`);
    return;
  }

  const state = await store.getGuild(guild.id);
  const saved = state.ticketConfig;
  if (saved !== null && saved.ticketStaffRoleId !== staffRole.id) {
    // Publish never edits channels, so a new staff role would leave the old one reading retained tickets.
    const stillGranted: string[] = [];
    for (const ticket of Object.values(state.tickets)) {
      const channel = await guild.channels.fetch(ticket.channelId).catch((error: unknown) =>
        isUnknownResource(error) ? null : ('unknown' as const),
      );
      if (channel === 'unknown' || (channel !== null && 'permissionOverwrites' in channel && channel.permissionOverwrites.cache.has(saved.ticketStaffRoleId)))
        stillGranted.push(ticket.channelId);
    }
    if (stillGranted.length > 0) {
      await interaction.editReply(
        [
          `Staff role not changed: ${String(stillGranted.length)} ticket channel(s) still grant <@&${saved.ticketStaffRoleId}> access.`,
          'Remove that role from these channels (or delete them), then rerun publish. Nothing was saved.',
          ...stillGranted.slice(0, 10).map((id) => `<#${id}>`),
        ].join('\n'),
      );
      return;
    }
  }

  const payload = ticketCenterPanel();
  let panelMessageId: string | null = null;
  if (saved?.ticketPanelMessageId != null) {
    let previous: Message | null;
    try {
      const previousChannel = await guild.channels.fetch(saved.ticketPanelChannelId);
      previous =
        previousChannel?.type === ChannelType.GuildText
          ? await previousChannel.messages.fetch(saved.ticketPanelMessageId)
          : null;
    } catch (error) {
      if (!isUnknownResource(error)) {
        logger.warn({ err: error, guildId: guild.id }, 'Could not verify the existing ticket panel');
        await interaction.editReply('Xenon could not verify the existing ticket panel. Nothing was changed; try again shortly.');
        return;
      }
      previous = null;
    }
    // Only ever touch Xenon's own panel message.
    if (previous?.author.id === me.id) {
      if (previous.channelId === panelChannel.id) {
        await previous.edit(payload);
        panelMessageId = previous.id;
      } else {
        try {
          await previous.delete();
        } catch (error) {
          logger.warn({ err: error, guildId: guild.id }, 'Could not remove the previous ticket panel');
          await interaction.editReply('Xenon could not remove the previous ticket panel. Nothing was changed; try again shortly.');
          return;
        }
      }
    }
  }
  const posted = panelMessageId === null ? await panelChannel.send(payload) : null;
  panelMessageId ??= posted?.id ?? null;

  try {
    await store.saveTicketConfig(guild.id, {
      ticketPanelChannelId: panelChannel.id,
      ticketCategoryId: category.id,
      ticketLogChannelId: logChannel.id,
      ticketStaffRoleId: staffRole.id,
      ticketPanelMessageId: panelMessageId,
    });
  } catch (error) {
    // Never leave an untracked panel behind.
    await posted?.delete().catch(() => undefined);
    throw error;
  }
  await interaction.editReply(
    [
      'XENON TICKETS PUBLISHED',
      '',
      `Panel: <#${panelChannel.id}>`,
      `Ticket category: ${category.name}`,
      `Log channel: <#${logChannel.id}>`,
      `Staff role: <@&${staffRole.id}>`,
      '',
      'No channels or roles were created or modified.',
    ].join('\n'),
  );
}

function missingPermissions(missing: readonly string[], where: string): string[] {
  return missing.length === 0 ? [] : [`${where}: ${missing.join(', ')}`];
}

// ── /xenon tickets status ───────────────────────────────────────────────────

export async function ticketStatus(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
  store: DiscordRuntimeStore,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const state = await store.getGuild(guild.id);
  const config = state.ticketConfig;
  if (config === null) {
    await interaction.editReply('Tickets are not configured. Run /xenon tickets publish.');
    return;
  }
  const tickets = Object.values(state.tickets);
  const resources = await resolveResources(guild, config);
  const panel =
    resources.panelChannel?.type === ChannelType.GuildText && config.ticketPanelMessageId !== null
      ? await resources.panelChannel.messages.fetch(config.ticketPanelMessageId).catch(() => null)
      : null;
  const healthy = (present: boolean, label: string) => `${label}${present ? '' : ' — MISSING'}`;
  const problems = panel === null || !resources.complete;
  await interaction.editReply(
    [
      'XENON TICKETS',
      '',
      healthy(panel !== null, `Panel: <#${config.ticketPanelChannelId}>`),
      healthy(resources.category !== null, `Ticket category: ${resources.category?.name ?? config.ticketCategoryId}`),
      healthy(resources.logChannel !== null, `Log channel: <#${config.ticketLogChannelId}>`),
      healthy(resources.staffRole !== null, `Staff role: <@&${config.ticketStaffRoleId}>`),
      '',
      `Open tickets: ${String(tickets.filter((ticket) => ticket.status === 'OPEN').length)}`,
      `Closed tickets: ${String(tickets.filter((ticket) => ticket.status === 'CLOSED').length)}`,
      ...(problems ? ['', 'Some resources are missing. Rerun /xenon tickets publish.'] : []),
    ].join('\n'),
  );
}

async function resolveResources(guild: Guild, config: TicketConfig) {
  const [panelChannel, category, logChannel, staffRole] = await Promise.all([
    guild.channels.fetch(config.ticketPanelChannelId).catch(() => null),
    guild.channels.fetch(config.ticketCategoryId).catch(() => null),
    guild.channels.fetch(config.ticketLogChannelId).catch(() => null),
    guild.roles.fetch(config.ticketStaffRoleId).catch(() => null),
  ]);
  const validCategory = category?.type === ChannelType.GuildCategory ? category : null;
  const validLog = logChannel?.type === ChannelType.GuildText ? logChannel : null;
  return {
    panelChannel,
    category: validCategory,
    logChannel: validLog,
    staffRole,
    complete: panelChannel !== null && validCategory !== null && validLog !== null && staffRole !== null,
  };
}

// ── Create ──────────────────────────────────────────────────────────────────

export async function openTicketFromSelect(
  interaction: StringSelectMenuInteraction,
  store: DiscordRuntimeStore,
): Promise<void> {
  const guild = interaction.guild;
  if (guild === null) {
    await interaction.reply({ content: 'Open tickets inside the Xenon Discord server.', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const reply = (content: string) => interaction.editReply({ content, allowedMentions: { parse: [] } });

  const category = TICKET_CATEGORIES.find((candidate) => candidate.value === interaction.values[0]);
  if (category === undefined) {
    await reply('Choose one of the listed ticket categories.');
    return;
  }
  const state = await store.getGuild(guild.id);
  const config = state.ticketConfig;
  if (config === null) {
    await reply('Tickets are not configured yet. Please contact a Xenon staff member.');
    return;
  }
  if (interaction.message.id !== config.ticketPanelMessageId || interaction.channelId !== config.ticketPanelChannelId) {
    await reply('This ticket panel is no longer active. Use the current XENON SUPPORT CENTER panel.');
    return;
  }

  const userId = interaction.user.id;
  const key = `${guild.id}:${userId}`;
  if (creating.has(key)) {
    await reply('Your ticket is already being created.');
    return;
  }
  creating.add(key);
  try {
    const existing = Object.values(state.tickets).find(
      (ticket) => ticket.ownerId === userId && ticket.status === 'OPEN',
    );
    if (existing !== undefined) {
      let channelGone = false;
      try {
        await guild.channels.fetch(existing.channelId);
      } catch (error) {
        if (!isUnknownResource(error)) {
          logger.warn({ err: error, guildId: guild.id }, 'Could not verify an existing ticket channel');
          await reply('Xenon could not verify your existing ticket. Please try again shortly.');
          return;
        }
        channelGone = true;
      }
      if (!channelGone) {
        await reply(`You already have an open ticket: <#${existing.channelId}>`);
        return;
      }
      // Discord confirmed the channel was deleted by hand; release the owner instead of locking them out.
      await store.closeTicket(guild.id, existing.ticketId, null, new Date().toISOString());
    }
    const now = Date.now();
    if (now - (lastCreation.get(key) ?? 0) < CREATE_COOLDOWN_MS) {
      await reply('Please wait a minute before opening another ticket.');
      return;
    }

    const resources = await resolveResources(guild, config);
    if (resources.category === null || resources.staffRole === null || resources.logChannel === null) {
      logger.warn({ guildId: guild.id }, 'A configured ticket resource is missing');
      await reply(RERUN_PUBLISH);
      return;
    }
    lastCreation.set(key, now);

    const ticketId = await store.reserveTicketId(guild.id);
    const me = await guild.members.fetchMe();
    const channel = await guild.channels
      .create({
        name: ticketChannelName(interaction.user.username, ticketId),
        type: ChannelType.GuildText,
        parent: resources.category.id,
        topic: `Xenon support ticket ${ticketId}`,
        reason: `Xenon support ticket ${ticketId}`,
        permissionOverwrites: [
          { id: guild.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
          { id: userId, type: OverwriteType.Member, allow: OWNER_ALLOW },
          { id: resources.staffRole.id, type: OverwriteType.Role, allow: STAFF_ALLOW },
          { id: me.id, type: OverwriteType.Member, allow: BOT_ALLOW },
        ],
      })
      .catch((error: unknown) => {
        logger.warn({ err: error, guildId: guild.id, ticketId }, 'Ticket channel creation failed');
        return null;
      });
    if (channel === null) {
      await reply('Xenon could not create your ticket channel. Please contact a Xenon staff member.');
      return;
    }

    const ticket: TicketRecord = {
      ticketId,
      guildId: guild.id,
      channelId: channel.id,
      ownerId: userId,
      category: category.value,
      createdAt: new Date(now).toISOString(),
      closedAt: null,
      closedBy: null,
      status: 'OPEN',
    };
    let opened: boolean;
    try {
      opened = await store.openTicket(ticket);
    } catch (error) {
      logger.error({ err: error, guildId: guild.id, ticketId }, 'Ticket record could not be saved');
      await channel.delete('Xenon ticket record could not be saved').catch((deleteError: unknown) => {
        logger.error({ err: deleteError, guildId: guild.id, channelId: channel.id }, 'Untracked ticket channel left behind');
      });
      await reply('Xenon could not save your ticket. Please try again shortly.');
      return;
    }
    if (!opened) {
      await channel.delete('Duplicate Xenon ticket').catch(() => undefined);
      await reply('You already have an open ticket.');
      return;
    }

    try {
      await channel.send({
        content: `<@${userId}> <@&${resources.staffRole.id}>`,
        embeds: [openedEmbed(ticket)],
        components: [
          new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
              new ButtonBuilder()
                .setCustomId(xenonIds.ticketClose(ticketId))
                .setLabel('CLOSE TICKET')
                .setStyle(ButtonStyle.Danger),
            )
            .toJSON(),
        ],
        allowedMentions: { users: [userId], roles: [resources.staffRole.id] },
      });
    } catch (error) {
      // Without the opening message nobody can close it, so undo the ticket entirely.
      logger.warn({ err: error, guildId: guild.id, ticketId }, 'Ticket opening message failed');
      await store.closeTicket(guild.id, ticketId, null, new Date().toISOString()).catch(() => null);
      await channel.delete('Xenon ticket could not be initialised').catch(() => undefined);
      await reply('Xenon could not set up your ticket channel. Please try again shortly.');
      return;
    }
    await reply(`Ticket created: <#${channel.id}>`);
  } finally {
    creating.delete(key);
  }
}

/** `ticket-<username>-<number>`: Discord-safe characters only, unique by ticket number. */
export function ticketChannelName(username: string, ticketId: string): string {
  const slug =
    username
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'member';
  return `ticket-${slug}-${ticketId.slice('XN-TK-'.length)}`;
}

// ── Close ───────────────────────────────────────────────────────────────────

export async function closeTicketFromButton(
  interaction: ButtonInteraction,
  ticketId: string,
  store: DiscordRuntimeStore,
): Promise<void> {
  const deny = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  if (guild === null) {
    await deny('Close tickets inside the Xenon Discord server.');
    return;
  }
  const state = await store.getGuild(guild.id);
  const ticket = state.tickets[ticketId];
  if (ticket?.guildId !== guild.id || ticket.channelId !== interaction.channelId) {
    await deny('This ticket could not be verified.');
    return;
  }
  if (ticket.status !== 'OPEN') {
    await deny('This ticket is already closed.');
    return;
  }
  if (!(await canClose(interaction, guild, ticket, state.ticketConfig))) {
    await deny('Only the ticket owner or the Xenon staff team can close this ticket.');
    return;
  }

  // Acknowledge first so the remaining Discord calls are not racing the interaction window.
  await interaction.deferUpdate();
  const followUp = (content: string) => interaction.followUp({ content, flags: MessageFlags.Ephemeral });

  // Revoke the owner's write access before recording CLOSED. If this fails the ticket stays
  // OPEN and its button keeps working, so closing can simply be retried.
  let channel: TextChannel;
  try {
    const fetched = await guild.channels.fetch(ticket.channelId);
    if (fetched?.type !== ChannelType.GuildText) throw new Error('Ticket channel is not a text channel');
    channel = fetched;
    await channel.permissionOverwrites.edit(
      ticket.ownerId,
      {
        ViewChannel: true,
        SendMessages: false,
        SendMessagesInThreads: false,
        CreatePublicThreads: false,
        CreatePrivateThreads: false,
      },
      { type: OverwriteType.Member, reason: `Xenon ticket ${ticketId} closed` },
    );
  } catch (error) {
    logger.warn({ err: error, guildId: guild.id, ticketId }, 'Could not lock ticket owner on close');
    await followUp('Xenon could not lock this ticket, so it is still open. Try again or contact Xenon management.');
    return;
  }

  const closed = await store.closeTicket(guild.id, ticketId, interaction.user.id, new Date().toISOString());
  if (closed === null) {
    await followUp('This ticket is already closed.');
    return;
  }

  const problems: string[] = [];
  const step = async (label: string, action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      logger.warn({ err: error, guildId: guild.id, ticketId }, `Ticket close step failed: ${label}`);
      problems.push(label);
    }
  };

  // Replace the opening message without its buttons.
  await step('remove buttons', () => interaction.editReply({ embeds: [openedEmbed(ticket)], components: [] }));
  await step('closed notice', () =>
    channel.send({
      embeds: [
        XenonBasePanel({
          title: 'XENON SUPPORT · TICKET CLOSED',
          description: 'This ticket is closed. The channel is kept for staff review.',
          tone: 'neutral',
          footer: 'XenonRP • Support',
          timestamp: new Date(closed.closedAt ?? Date.now()),
        })
          .addFields(
            { name: 'Ticket', value: ticketId, inline: true },
            { name: 'Closed by', value: `<@${interaction.user.id}>`, inline: true },
          )
          .toJSON(),
      ],
      allowedMentions: { parse: [] },
    }),
  );

  const logChannel =
    state.ticketConfig === null
      ? null
      : await guild.channels.fetch(state.ticketConfig.ticketLogChannelId).catch(() => null);
  if (logChannel?.type === ChannelType.GuildText) {
    await step('log', () => logChannel.send({ embeds: [closeLogEmbed(closed)], allowedMentions: { parse: [] } }));
  } else {
    problems.push('log channel missing — rerun /xenon tickets publish');
  }

  // Renames are heavily rate limited by Discord, so it runs last.
  await step('rename', () => channel.setName(`closed-${ticketId.toLowerCase()}`, `Xenon ticket ${ticketId} closed`));

  if (problems.length > 0)
    await followUp(`Ticket ${ticketId} is closed and locked, but some steps failed: ${problems.join('; ')}.`);
}

async function canClose(
  interaction: ButtonInteraction,
  guild: Guild,
  ticket: TicketRecord,
  config: TicketConfig | null,
): Promise<boolean> {
  const userId = interaction.user.id;
  if (ticket.ownerId === userId) return true;
  if (guild.ownerId === userId || interaction.memberPermissions?.has(P.ManageGuild) === true) return true;
  if (config === null) return false;
  const member: GuildMember | null = await guild.members.fetch(userId).catch(() => null);
  return member?.roles.cache.has(config.ticketStaffRoleId) === true;
}

function closeLogEmbed(ticket: TicketRecord) {
  return XenonBasePanel({
    title: `TICKET CLOSED · ${ticket.ticketId}`,
    description: 'A Xenon support ticket was closed. The channel is kept for review.',
    tone: 'neutral',
    footer: 'XenonRP • Ticket Log',
    timestamp: new Date(ticket.closedAt ?? Date.now()),
  })
    .addFields(
      { name: 'Ticket', value: ticket.ticketId, inline: true },
      { name: 'Owner', value: memberMention(ticket.ownerId), inline: true },
      { name: 'Category', value: categoryLabel(ticket.category), inline: true },
      { name: 'Opened', value: unixTime(ticket.createdAt), inline: true },
      { name: 'Closed', value: unixTime(ticket.closedAt), inline: true },
      { name: 'Closed by', value: memberMention(ticket.closedBy), inline: true },
      { name: 'Channel', value: `<#${ticket.channelId}> (${ticket.channelId})` },
    )
    .toJSON();
}
