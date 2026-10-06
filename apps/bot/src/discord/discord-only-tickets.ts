import { setTimeout as sleep } from 'node:timers/promises';

import {
  ActionRowBuilder,
  ApplicationFlags,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  OverwriteType,
  PermissionFlagsBits as P,
  RESTJSONErrorCodes,
  StringSelectMenuBuilder,
  type APIActionRowComponent,
  type APIComponentInMessageActionRow,
  type ButtonInteraction,
  type Client,
  type CategoryChannel,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type Message,
  type StringSelectMenuInteraction,
  type TextChannel,
} from 'discord.js';

import { xenonIds } from '@xenon/discord/interaction-ids';
import { XenonBasePanel } from '@xenon/discord/panels';

import { botEnv, logger } from '../runtime';

import type { DiscordGuildRuntimeState, DiscordRuntimeStore, TicketConfig, TicketRecord } from './runtime-store';

/**
 * Discord-only support tickets.
 *
 * Management picks the existing panel channel, log channel and staff role with
 * `/xenon tickets publish`; this module only stores their ids. Xenon creates
 * and owns exactly: one private Discord category per ticket type, the panel
 * message, and one private text channel per ticket. Ticket channels are
 * deleted after closing, once the log entry and transcript are posted.
 */

/** Each type gets its own Xenon-created Discord category, named `<label> Tickets`. */
export const TICKET_CATEGORIES = [
  { value: 'GENERAL', emoji: '💬', label: 'General Support', summary: 'General questions and assistance', menu: 'General questions and assistance' },
  { value: 'TECHNICAL', emoji: '🛠️', label: 'Technical Support', summary: 'Discord, FiveM, launcher or server issues', menu: 'Discord, FiveM or server issues' },
  { value: 'CHARACTER', emoji: '🎭', label: 'Character Issue', summary: 'Problems involving your character or character data', menu: 'Character-related problems' },
  { value: 'WHITELIST', emoji: '📜', label: 'Whitelist Support', summary: 'Whitelist, application or interview assistance', menu: 'Application or whitelist assistance' },
  { value: 'PLAYER_REPORT', emoji: '🚩', label: 'Player Report', summary: 'Report a player or rule violation', menu: 'Report a player or rule violation' },
  { value: 'STAFF_REPORT', emoji: '⚖️', label: 'Staff Report', summary: 'Report a Xenon staff member privately', menu: 'Privately report a staff member' },
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
/**
 * Guild-level: the bot creates the ticket categories, and can only grant
 * permissions it holds; Manage Roles is needed to write overwrites.
 */
const GUILD_REQUIRED = [...new Set([...OWNER_ALLOW, ...STAFF_ALLOW, ...BOT_ALLOW, P.ManageRoles])];
const MESSAGE_CHANNEL_REQUIRED = [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ReadMessageHistory];
/** Transcripts are uploaded as files. */
const LOG_CHANNEL_REQUIRED = [...MESSAGE_CHANNEL_REQUIRED, P.AttachFiles];

const CREATE_COOLDOWN_MS = 60_000;
/** Bounded transcript: newest messages win when a ticket is longer than this. */
const TRANSCRIPT_MESSAGE_LIMIT = 500;
export const RERUN_PUBLISH =
  'Tickets are temporarily unavailable. Xenon management must rerun /xenon tickets publish.';
export const ALREADY_CLOSING = 'This ticket is already closing or closed.';

const lastCreation = new Map<string, number>();
const creating = new Set<string>();
let deleteDelayMs = 5_000;

/** Test seam: the per-user creation cooldown is process memory. */
export function resetTicketCooldowns(): void {
  lastCreation.clear();
  creating.clear();
}

/** Test seam: the pause between the closed notice and channel deletion. */
export function setTicketDeleteDelay(ms: number): void {
  deleteDelayMs = ms;
}

/** A public https URL only; localhost and placeholder hosts never become buttons. */
function publicUrl(value: string | null | undefined): string | null {
  if (value == null) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:') return null;
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost')) return null;
    if (/^(?:127\.|10\.|192\.168\.|0\.0\.0\.0)/.test(host) || /(?:^|\.)example\.(?:com|org|net)$/.test(host)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function ticketCenterPanel(options: { readonly siteUrl?: string | null; readonly thumbnailUrl?: string | null } = {}) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(xenonIds.ticketCreate())
    .setPlaceholder('🎟️ Select a support category')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      TICKET_CATEGORIES.map(({ value, emoji, label, menu }) => ({ value, label, description: menu, emoji: { name: emoji } })),
    );
  const embed = XenonBasePanel({
    title: '🎫 XENON SUPPORT CENTER',
    description: [
      'Welcome to the **Xenon Roleplay Support Center**.',
      '',
      'Need help with something? Select the category that best matches your issue below and Xenon will create a private ticket for you.',
      '',
      '> Please describe your issue clearly after opening the ticket.',
      '> A staff member will assist you as soon as possible.',
    ].join('\n'),
    footer: 'Xenon Support • Xenon Roleplay',
    timestamp: new Date(),
  }).addFields({
    name: '📊 AVAILABLE CATEGORIES',
    value: TICKET_CATEGORIES.map(({ emoji, label, summary }) => `${emoji} **${label}**\n└ ${summary}`).join('\n\n'),
  });
  if (options.thumbnailUrl != null) embed.setThumbnail(options.thumbnailUrl);

  const components: APIActionRowComponent<APIComponentInMessageActionRow>[] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select).toJSON(),
  ];
  const website = publicUrl(options.siteUrl);
  if (website !== null)
    components.push(
      new ActionRowBuilder<ButtonBuilder>()
        .addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('WEBSITE').setEmoji('🌐').setURL(website))
        .toJSON(),
    );
  return { embeds: [embed.toJSON()], components };
}

function categoryLabel(value: string): string {
  // Tickets opened under since-retired types keep their stored value.
  return TICKET_CATEGORIES.find((category) => category.value === value)?.label ?? value;
}

function relativeTime(iso: string): string {
  return `<t:${String(Math.floor(new Date(iso).getTime() / 1000))}:R>`;
}

function fullTime(iso: string | null): string {
  return iso === null ? 'Unknown' : `<t:${String(Math.floor(new Date(iso).getTime() / 1000))}:F>`;
}

/** `3d 4h`, `2h 14m`, `5m 3s`, `42s`. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  if (days > 0) return `${String(days)}d ${String(hours)}h`;
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`;
  if (minutes > 0) return `${String(minutes)}m ${String(rest)}s`;
  return `${String(rest)}s`;
}

function openedEmbed(ticket: TicketRecord) {
  const embed = XenonBasePanel({
    title: '🎫 XENON SUPPORT · TICKET OPENED',
    description: [
      `Welcome <@${ticket.ownerId}>.`,
      '',
      'Your private support ticket has been created successfully.',
      'Explain your issue below with as much useful information as possible.',
      '',
      'Staff will respond when available.',
      '',
      '### What happens next?',
      '• Describe the issue clearly',
      '• Attach screenshots/video when useful',
      '• Avoid repeatedly pinging staff',
      '• Wait for a support member to respond',
    ].join('\n'),
    footer: `Xenon Support • ${ticket.ticketId}`,
    timestamp: new Date(ticket.createdAt),
  }).addFields(
    { name: '🎟️ Ticket', value: ticket.ticketId, inline: true },
    { name: '📂 Category', value: categoryLabel(ticket.category), inline: true },
    { name: '👤 Opened By', value: `<@${ticket.ownerId}>`, inline: true },
    { name: '🕒 Created', value: relativeTime(ticket.createdAt), inline: true },
  );
  if (ticket.claimedBy !== null) embed.addFields({ name: '🙋 Claimed By', value: `<@${ticket.claimedBy}>`, inline: true });
  return embed.toJSON();
}

function ticketButtons(ticket: TicketRecord, disabled: boolean) {
  return new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(xenonIds.ticketClose(ticket.ticketId))
        .setLabel('CLOSE TICKET')
        .setEmoji('🔒')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(xenonIds.ticketClaim(ticket.ticketId))
        .setLabel(ticket.claimedBy === null ? 'CLAIM TICKET' : 'CLAIMED')
        .setEmoji('🙋')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || ticket.claimedBy !== null),
    )
    .toJSON();
}

/** Discord's "resource is gone" answers; any other failure means "unknown", never "missing". */
function isUnknownResource(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  return code === RESTJSONErrorCodes.UnknownChannel || code === RESTJSONErrorCodes.UnknownMessage;
}

/** Error code and message only: Discord API errors can carry request bodies. */
function safeError(error: unknown): { readonly code: string | number | null; readonly message: string } {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  return {
    code: typeof code === 'string' || typeof code === 'number' ? code : null,
    message: error instanceof Error ? error.message.slice(0, 200) : 'Unknown error',
  };
}

/** Staff for tickets: guild owner, ManageGuild, or the configured ticket staff role. */
async function isTicketStaff(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  guild: Guild,
  config: TicketConfig | null,
): Promise<boolean> {
  const userId = interaction.user.id;
  if (guild.ownerId === userId || interaction.memberPermissions?.has(P.ManageGuild) === true) return true;
  if (config === null) return false;
  const member: GuildMember | null = await guild.members.fetch(userId).catch(() => null);
  return member?.roles.cache.has(config.ticketStaffRoleId) === true;
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
  const [panelChannel, logChannel, staffRole] = await Promise.all([
    guild.channels.fetch(interaction.options.getChannel('panel_channel', true).id).catch(() => null),
    guild.channels.fetch(interaction.options.getChannel('log_channel', true).id).catch(() => null),
    guild.roles.fetch(interaction.options.getRole('staff_role', true).id).catch(() => null),
  ]);

  if (panelChannel?.guildId !== guild.id || panelChannel.type !== ChannelType.GuildText) {
    await interaction.editReply('panel_channel must be an existing text channel in this server. Nothing was saved.');
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
    ...missingPermissions(me.permissions.missing(GUILD_REQUIRED), 'server'),
    ...missingPermissions(panelChannel.permissionsFor(me).missing(MESSAGE_CHANNEL_REQUIRED), `#${panelChannel.name}`),
    ...missingPermissions(logChannel.permissionsFor(me).missing(LOG_CHANNEL_REQUIRED), `#${logChannel.name}`),
  ];
  if (missing.length > 0) {
    await interaction.editReply(`Xenon is missing permissions. Nothing was saved.\n${missing.join('\n')}`);
    return;
  }

  const state = await store.getGuild(guild.id);
  const saved = state.ticketConfig;
  if (saved !== null && saved.ticketStaffRoleId !== staffRole.id) {
    // Publish never edits ticket channels, so a new staff role would leave the old one reading retained tickets.
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

  const categories = await ensureTicketCategories(guild, me.id, staffRole.id, saved?.ticketStaffRoleId ?? null, store);
  if (typeof categories === 'string') {
    await interaction.editReply(categories);
    return;
  }

  const payload = ticketCenterPanel({ siteUrl: botEnv.NEXT_PUBLIC_SITE_URL, thumbnailUrl: guild.iconURL({ size: 256 }) });
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
      `✅ Xenon Support Center published in <#${panelChannel.id}>`,
      ...(messageContentAvailable(interaction)
        ? []
        : ['⚠️ Message Content Intent is disabled for this bot, so ticket transcripts will not include message text or attachments. Enable it in the Discord Developer Portal.']),
      ...(categories.created === 0
        ? []
        : [`Created ${String(categories.created)} private ticket categor${categories.created === 1 ? 'y' : 'ies'}: ${categories.createdNames.join(', ')}`]),
    ].join('\n'),
  );
}

/**
 * Reuses each Xenon-created ticket category that still exists and creates the
 * missing ones. Every id is saved the moment its category exists, so a failure
 * part-way never leaves an untracked category to be duplicated next time.
 */
async function ensureTicketCategories(
  guild: Guild,
  botId: string,
  staffRoleId: string,
  previousStaffRoleId: string | null,
  store: DiscordRuntimeStore,
): Promise<{ readonly created: number; readonly createdNames: string[] } | string> {
  const stored = (await store.getGuild(guild.id)).ticketCategories;
  const createdNames: string[] = [];
  for (const type of TICKET_CATEGORIES) {
    const storedId = stored[type.value];
    let category: CategoryChannel | null = null;
    if (storedId !== undefined) {
      try {
        const fetched = await guild.channels.fetch(storedId);
        category = fetched?.type === ChannelType.GuildCategory ? fetched : null;
      } catch (error) {
        if (!isUnknownResource(error)) {
          logger.warn({ err: error, guildId: guild.id }, 'Could not verify a ticket category');
          return `Xenon could not verify the ${type.label} ticket category. Try again shortly.`;
        }
      }
    }
    if (category === null) {
      category = await guild.channels.create({
        name: `${type.label} Tickets`,
        type: ChannelType.GuildCategory,
        reason: 'Xenon ticket category',
        permissionOverwrites: [
          { id: guild.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
          { id: staffRoleId, type: OverwriteType.Role, allow: STAFF_ALLOW },
          { id: botId, type: OverwriteType.Member, allow: BOT_ALLOW },
        ],
      });
      await store.saveTicketCategory(guild.id, type.value, category.id);
      createdNames.push(category.name);
    } else if (previousStaffRoleId !== null && previousStaffRoleId !== staffRoleId) {
      // Xenon owns these categories, so it keeps their staff access in step with the configured role.
      await category.permissionOverwrites.delete(previousStaffRoleId, 'Xenon ticket staff role changed');
      await category.permissionOverwrites.edit(
        staffRoleId,
        { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, ManageMessages: true },
        { type: OverwriteType.Role, reason: 'Xenon ticket staff role changed' },
      );
    }
  }
  return { created: createdNames.length, createdNames };
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
  const categories = await Promise.all(
    TICKET_CATEGORIES.map(async (type) => ({ type, category: await ticketCategory(guild, state.ticketCategories[type.value]) })),
  );
  const healthy = (present: boolean, label: string) => `${label}${present ? '' : ' — MISSING'}`;
  const problems = panel === null || !resources.complete || categories.some(({ category }) => category === null);
  await interaction.editReply(
    [
      'XENON TICKETS',
      '',
      healthy(panel !== null, `Panel: <#${config.ticketPanelChannelId}>`),
      healthy(resources.logChannel !== null, `Log channel: <#${config.ticketLogChannelId}>`),
      healthy(resources.staffRole !== null, `Staff role: <@&${config.ticketStaffRoleId}>`),
      '',
      'Ticket categories:',
      ...categories.map(({ type, category }) => healthy(category !== null, `${type.label} → ${category?.name ?? 'not created'}`)),
      '',
      `Open tickets: ${String(tickets.filter((ticket) => ticket.status === 'OPEN').length)}`,
      `Closed tickets: ${String(tickets.filter((ticket) => ticket.status === 'CLOSED').length)}`,
      ...(problems ? ['', 'Some resources are missing. Rerun /xenon tickets publish.'] : []),
    ].join('\n'),
  );
}

async function ticketCategory(guild: Guild, categoryId: string | undefined): Promise<CategoryChannel | null> {
  if (categoryId === undefined) return null;
  const category = await guild.channels.fetch(categoryId).catch(() => null);
  return category?.type === ChannelType.GuildCategory ? category : null;
}

async function resolveResources(guild: Guild, config: TicketConfig) {
  const [panelChannel, logChannel, staffRole] = await Promise.all([
    guild.channels.fetch(config.ticketPanelChannelId).catch(() => null),
    guild.channels.fetch(config.ticketLogChannelId).catch(() => null),
    guild.roles.fetch(config.ticketStaffRoleId).catch(() => null),
  ]);
  const validLog = logChannel?.type === ChannelType.GuildText ? logChannel : null;
  return {
    panelChannel,
    logChannel: validLog,
    staffRole,
    complete: panelChannel !== null && validLog !== null && staffRole !== null,
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

    const [resources, parent] = await Promise.all([
      resolveResources(guild, config),
      ticketCategory(guild, state.ticketCategories[category.value]),
    ]);
    if (parent === null || resources.staffRole === null || resources.logChannel === null) {
      logger.warn({ guildId: guild.id }, 'A configured ticket resource is missing');
      await reply(RERUN_PUBLISH);
      return;
    }
    lastCreation.set(key, now);

    const ticketId = await store.reserveTicketId(guild.id);
    const me = await guild.members.fetchMe();
    const channel = await guild.channels
      .create({
        name: ticketChannelName(
          interaction.user.username,
          new Set([...guild.channels.cache.values()].map((existing) => existing.name)),
        ),
        type: ChannelType.GuildText,
        parent: parent.id,
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
      claimedBy: null,
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
        components: [ticketButtons(ticket, false)],
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

/** Longest slug kept so `ticket-<slug>-<n>` always fits Discord's 100-character limit. */
const MAX_NAME_SLUG = 80;

/** `ticket-<username>`, then `-2`, `-3`… on collision. The reference lives in runtime data. */
export function ticketChannelName(username: string, taken: ReadonlySet<string>): string {
  const slug =
    username
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_NAME_SLUG)
      .replace(/-+$/g, '') || 'member';
  const base = `ticket-${slug}`;
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${String(suffix)}`)) suffix += 1;
  return `${base}-${String(suffix)}`;
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
    await deny(ALREADY_CLOSING);
    return;
  }
  if (ticket.ownerId !== interaction.user.id && !(await isTicketStaff(interaction, guild, state.ticketConfig))) {
    await deny('Only the ticket owner or the Xenon staff team can close this ticket.');
    return;
  }

  // Acknowledge first so the remaining Discord calls are not racing the interaction window.
  await interaction.deferUpdate();
  // The atomic OPEN → CLOSED transition is the single gate: exactly one close flow passes it,
  // so a second press can never produce a second log, transcript or delete.
  const closed = await store.closeTicket(guild.id, ticketId, interaction.user.id, new Date().toISOString());
  if (closed === null) {
    await interaction.followUp({ content: ALREADY_CLOSING, flags: MessageFlags.Ephemeral });
    return;
  }

  const warn = (label: string, error: unknown) => {
    logger.warn({ guildId: guild.id, ticketId, step: label, error: safeError(error) }, 'Ticket close step failed');
  };
  await interaction
    .editReply({ embeds: [openedEmbed(closed)], components: [ticketButtons(closed, true)] })
    .catch((error: unknown) => {
      warn('disable buttons', error);
    });

  const fetched = await guild.channels.fetch(ticket.channelId).catch(() => null);
  const channel = fetched?.type === ChannelType.GuildText ? fetched : null;
  if (channel !== null) {
    // Nothing the owner writes from here on would make it into the transcript.
    await channel.permissionOverwrites
      .edit(
        ticket.ownerId,
        { SendMessages: false, SendMessagesInThreads: false, CreatePublicThreads: false, CreatePrivateThreads: false },
        { type: OverwriteType.Member, reason: `Xenon ticket ${ticketId} closed` },
      )
      .catch((error: unknown) => {
        warn('lock owner', error);
      });
    await channel
      .send({ embeds: [closedNoticeEmbed(closed)], allowedMentions: { parse: [] } })
      .catch((error: unknown) => {
        warn('closed notice', error);
      });
  }
  const noticeAt = Date.now();

  const contentAvailable = messageContentAvailable(interaction);
  let transcript: string | null = null;
  if (channel !== null) {
    try {
      transcript = await buildTranscript(channel, closed, contentAvailable);
    } catch (error) {
      warn('transcript', error);
    }
  }

  // The log must exist before anything is deleted. A transcript that cannot be uploaded
  // falls back to a metadata-only log rather than blocking the close.
  const config = state.ticketConfig;
  const fetchedLog =
    config === null ? null : await guild.channels.fetch(config.ticketLogChannelId).catch(() => null);
  const logChannel = fetchedLog?.type === ChannelType.GuildText ? fetchedLog : null;
  let logged = false;
  if (logChannel !== null) {
    const attempts: (string | null)[] = transcript === null ? [null] : [transcript, null];
    for (const attached of attempts) {
      try {
        await logChannel.send({
          embeds: [
            closeLogEmbed(
              closed,
              channel?.name ?? null,
              attached === null ? 'unavailable' : contentAvailable ? 'attached' : 'incomplete',
            ),
          ],
          files:
            attached === null
              ? []
              : [new AttachmentBuilder(Buffer.from(attached, 'utf8'), { name: `${ticketId}-transcript.txt` })],
          allowedMentions: { parse: [] },
        });
        logged = true;
        break;
      } catch (error) {
        warn(attached === null ? 'log' : 'log with transcript', error);
      }
    }
  }
  if (!logged || logChannel === null) {
    await interaction
      .followUp({
        content: `Ticket ${ticketId} is closed, but the ticket log could not be written, so the channel was kept for staff review. Xenon management should rerun /xenon tickets publish.`,
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => undefined);
    return;
  }
  if (channel === null) return;

  const remaining = deleteDelayMs - (Date.now() - noticeAt);
  if (remaining > 0) await sleep(remaining);

  // Re-read protection right before deleting: publish or adoption may have bound this
  // channel as infrastructure while the close was in progress.
  const latest = await store.getGuild(guild.id);
  if (publishing.has(guild.id) || !isDeletableTicketChannel(channel, closed, latest)) {
    logger.warn({ guildId: guild.id, ticketId, channelId: channel.id }, 'Refused to delete a protected channel');
    await sendDeleteWarning(logChannel, closed, channel, 'This channel is not a Xenon ticket channel, so it was not deleted.');
    return;
  }
  try {
    await channel.delete(`Xenon ticket ${ticketId} closed`);
  } catch (error) {
    // One attempt only: the ticket stays CLOSED and staff clean up by hand.
    warn('delete channel', error);
    const { code } = safeError(error);
    await sendDeleteWarning(
      logChannel,
      closed,
      channel,
      `Xenon could not delete this ticket channel${code === null ? '' : ` (Discord error ${String(code)})`}. Delete it manually.`,
    );
  }
}

/**
 * Discord returns message text and attachments over REST only when the
 * application's Message Content Intent is enabled in the Developer Portal.
 */
function messageContentAvailable(interaction: { readonly client: Client }): boolean {
  return (
    interaction.client.application?.flags.any([
      ApplicationFlags.GatewayMessageContent,
      ApplicationFlags.GatewayMessageContentLimited,
    ]) === true
  );
}

/**
 * Only the channel Xenon created for this ticket may be deleted, and never one
 * that is configured or adopted infrastructure, even if runtime data was edited.
 */
function isDeletableTicketChannel(
  channel: TextChannel,
  ticket: TicketRecord,
  state: DiscordGuildRuntimeState,
): boolean {
  const protectedIds = new Set<string>([
    ...(state.ticketConfig === null ? [] : [state.ticketConfig.ticketPanelChannelId, state.ticketConfig.ticketLogChannelId]),
    ...Object.values(state.ticketCategories),
    ...state.entries.flatMap((entry) => (entry.discordId === null ? [] : [entry.discordId])),
  ]);
  return channel.id === ticket.channelId && !protectedIds.has(channel.id);
}

async function sendDeleteWarning(logChannel: TextChannel, ticket: TicketRecord, channel: TextChannel, message: string) {
  await logChannel
    .send({
      embeds: [
        XenonBasePanel({
          title: '⚠️ TICKET CHANNEL NOT DELETED',
          description: message,
          tone: 'warning',
          footer: 'Xenon Support Logs',
          timestamp: new Date(),
        })
          .addFields(
            { name: 'Ticket', value: ticket.ticketId, inline: true },
            { name: 'Channel', value: `#${channel.name}\n\`${channel.id}\``, inline: true },
            { name: 'Status', value: 'CLOSED', inline: true },
          )
          .toJSON(),
      ],
      allowedMentions: { parse: [] },
    })
    .catch((error: unknown) => {
      logger.warn({ ticketId: ticket.ticketId, error: safeError(error) }, 'Ticket delete warning could not be logged');
    });
}

function closedNoticeEmbed(ticket: TicketRecord) {
  return XenonBasePanel({
    title: '🔒 XENON SUPPORT · TICKET CLOSED',
    description: [
      `Ticket **${ticket.ticketId}** has been closed by <@${ticket.closedBy ?? ticket.ownerId}>.`,
      '',
      `This channel will automatically be deleted in **${String(Math.round(deleteDelayMs / 1000))} seconds**.`,
      '',
      'Thank you for using Xenon Support.',
    ].join('\n'),
    tone: 'neutral',
    footer: `Xenon Support • ${ticket.ticketId}`,
    timestamp: new Date(ticket.closedAt ?? Date.now()),
  }).toJSON();
}

const TRANSCRIPT_STATE = {
  attached: (ticketId: string) => `Transcript attached: \`${ticketId}-transcript.txt\``,
  incomplete: (ticketId: string) =>
    `Transcript incomplete: \`${ticketId}-transcript.txt\` has authors and times only (Message Content Intent disabled)`,
  unavailable: () => 'Transcript unavailable',
} as const;

function closeLogEmbed(ticket: TicketRecord, channelName: string | null, transcript: keyof typeof TRANSCRIPT_STATE) {
  const mention = (id: string | null) => (id === null ? 'Xenon' : `<@${id}>\n\`${id}\``);
  return XenonBasePanel({
    title: '📁 XENON TICKET CLOSED',
    description: TRANSCRIPT_STATE[transcript](ticket.ticketId),
    tone: 'neutral',
    footer: 'Xenon Support Logs',
    timestamp: new Date(ticket.closedAt ?? Date.now()),
  })
    .addFields(
      { name: 'Ticket', value: ticket.ticketId, inline: true },
      { name: 'Category', value: categoryLabel(ticket.category), inline: true },
      { name: 'Status', value: 'CLOSED', inline: true },
      { name: 'Owner', value: mention(ticket.ownerId), inline: true },
      { name: 'Closed By', value: mention(ticket.closedBy), inline: true },
      ...(ticket.claimedBy === null ? [] : [{ name: 'Claimed By', value: mention(ticket.claimedBy), inline: true }]),
      { name: 'Opened', value: fullTime(ticket.createdAt), inline: true },
      { name: 'Closed', value: fullTime(ticket.closedAt), inline: true },
      {
        name: 'Duration',
        value: formatDuration(new Date(ticket.closedAt ?? Date.now()).getTime() - new Date(ticket.createdAt).getTime()),
        inline: true,
      },
      { name: 'Channel', value: `${channelName === null ? 'unknown' : `#${channelName}`}\n\`${ticket.channelId}\`` },
    )
    .toJSON();
}

/**
 * Plain-text transcript of the newest {@link TRANSCRIPT_MESSAGE_LIMIT}
 * messages: timestamp, username, user id, body and attachment URLs only.
 */
export async function buildTranscript(
  channel: TextChannel,
  ticket: TicketRecord,
  contentAvailable: boolean,
): Promise<string> {
  const messages: Message[] = [];
  let before: string | undefined;
  while (messages.length < TRANSCRIPT_MESSAGE_LIMIT) {
    const page = await channel.messages.fetch({
      limit: Math.min(100, TRANSCRIPT_MESSAGE_LIMIT - messages.length),
      ...(before === undefined ? {} : { before }),
    });
    messages.push(...page.values());
    if (page.size < 100) break;
    before = page.last()?.id;
    if (before === undefined) break;
  }
  messages.sort((left, right) => left.createdTimestamp - right.createdTimestamp);

  const lines = [
    `Xenon Support transcript — ${ticket.ticketId}`,
    `Category: ${categoryLabel(ticket.category)}`,
    `Owner: ${ticket.ownerId}`,
    `Opened: ${ticket.createdAt}`,
    `Closed: ${ticket.closedAt ?? 'unknown'} by ${ticket.closedBy ?? 'Xenon'}`,
    `Messages: ${String(messages.length)}${messages.length >= TRANSCRIPT_MESSAGE_LIMIT ? ` (newest ${String(TRANSCRIPT_MESSAGE_LIMIT)} only)` : ''}`,
    ...(contentAvailable
      ? []
      : ['NOTE: Message Content Intent is disabled for this bot, so Discord withheld message text and attachments.']),
    '',
  ];
  for (const message of messages) {
    const embedTitles = message.embeds.map((embed) => embed.title).filter((title): title is string => title !== null);
    const body = message.content.length > 0 ? message.content : embedTitles.length > 0 ? `[embed] ${embedTitles.join(' | ')}` : '';
    lines.push(`[${new Date(message.createdTimestamp).toISOString()}] ${message.author.username} (${message.author.id}): ${body}`);
    for (const attachment of message.attachments.values()) lines.push(`    attachment: ${attachment.url}`);
  }
  return `${lines.join('\n')}\n`;
}

// ── Claim ───────────────────────────────────────────────────────────────────

export async function claimTicketFromButton(
  interaction: ButtonInteraction,
  ticketId: string,
  store: DiscordRuntimeStore,
): Promise<void> {
  const deny = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  if (guild === null) {
    await deny('Claim tickets inside the Xenon Discord server.');
    return;
  }
  const state = await store.getGuild(guild.id);
  const ticket = state.tickets[ticketId];
  if (ticket?.guildId !== guild.id || ticket.channelId !== interaction.channelId) {
    await deny('This ticket could not be verified.');
    return;
  }
  if (!(await isTicketStaff(interaction, guild, state.ticketConfig))) {
    await deny('Only the Xenon staff team can claim tickets.');
    return;
  }
  const claimed = await store.claimTicket(guild.id, ticketId, interaction.user.id);
  if (claimed === null) {
    await deny(ticket.status === 'OPEN' ? 'This ticket has already been claimed.' : ALREADY_CLOSING);
    return;
  }
  await interaction.update({ embeds: [openedEmbed(claimed)], components: [ticketButtons(claimed, false)] });
  await interaction
    .followUp({ content: `🙋 <@${interaction.user.id}> has claimed this ticket and will assist you.`, allowedMentions: { parse: [] } })
    .catch(() => undefined);
}
