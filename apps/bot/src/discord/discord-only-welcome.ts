import {
  ApplicationFlags,
  AttachmentBuilder,
  ChannelType,
  escapeMarkdown,
  MessageFlags,
  PermissionFlagsBits as P,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type GuildMember,
  type Message,
  type NewsChannel,
  type Role,
  type TextChannel,
} from 'discord.js';

import { XenonBasePanel } from '@xenon/discord/panels';

import { logger } from '../runtime';

import {
  MAX_WELCOME_DELETE_SECONDS,
  type DiscordGuildRuntimeState,
  type DiscordRuntimeStore,
  type WelcomeConfig,
} from './runtime-store';
import { cardName, fetchAvatar, renderWelcomeCard, type WelcomeCardInput } from './welcome-card';

/**
 * Discord-only member welcome: one public message with a generated Xenon card,
 * an optional safe starter role and an optional DM. Configured entirely with
 * `/xenon welcome …`; no database, queue or third-party bot involved.
 */

export const WELCOME_TOKENS = [
  'mention',
  'username',
  'displayName',
  'server',
  'memberCount',
  'rulesChannel',
  'rolesChannel',
] as const;

/** Permissions that make a role staff, moderation or administrative; never auto-assigned. */
const PRIVILEGED_PERMISSIONS = [
  P.Administrator,
  P.ManageGuild,
  P.ManageRoles,
  P.ManageChannels,
  P.ManageWebhooks,
  P.ManageGuildExpressions,
  P.ManageEvents,
  P.ManageThreads,
  P.ManageMessages,
  P.ManageNicknames,
  P.KickMembers,
  P.BanMembers,
  P.ModerateMembers,
  P.MuteMembers,
  P.DeafenMembers,
  P.MoveMembers,
  P.MentionEveryone,
  P.ViewAuditLog,
  P.ViewGuildInsights,
];

const DEDUPE_WINDOW_MS = 60_000;
const recentJoins = new Map<string, number>();

/** Test seam: duplicate-join suppression is process memory. */
export function resetWelcomeDedupe(): void {
  recentJoins.clear();
}

export interface WelcomeDeps {
  readonly fetchAvatar: (url: string) => Promise<Buffer | null>;
  readonly renderCard: (input: WelcomeCardInput) => Promise<Buffer>;
}

const defaultDeps: WelcomeDeps = { fetchAvatar: (url) => fetchAvatar(url), renderCard: renderWelcomeCard };

type WelcomeChannel = TextChannel | NewsChannel;

// ── Text ──────────────────────────────────────────────────────────────────

export function ordinal(value: number): string {
  const tens = value % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][value % 10] ?? 'th');
  return `${String(value)}${suffix}`;
}

export interface WelcomeTextContext {
  readonly memberId: string;
  readonly username: string;
  readonly displayName: string;
  readonly guildName: string;
  /** null omits every member-count phrase. */
  readonly memberCount: number | null;
}

/** Unknown `{tokens}` in a custom message; empty when the message is valid. */
export function unknownWelcomeTokens(message: string): string[] {
  return [...message.matchAll(/\{([^{}]*)\}/g)]
    .map((match) => match[1] ?? '')
    .filter((token) => !(WELCOME_TOKENS as readonly string[]).includes(token));
}

/** Public welcome text. Only whitelisted tokens are substituted; nothing else is evaluated. */
export function renderWelcomeText(config: WelcomeConfig, context: WelcomeTextContext): string {
  const rules = config.rulesChannelId === null ? null : `<#${config.rulesChannelId}>`;
  const roles = config.rolesChannelId === null ? null : `<#${config.rolesChannelId}>`;
  if (config.customMessage !== null) {
    const values: Record<(typeof WELCOME_TOKENS)[number], string> = {
      mention: `<@${context.memberId}>`,
      username: escapeMarkdown(context.username),
      displayName: escapeMarkdown(context.displayName),
      server: escapeMarkdown(context.guildName),
      memberCount: context.memberCount === null ? '' : String(context.memberCount),
      rulesChannel: rules ?? '',
      rolesChannel: roles ?? '',
    };
    return config.customMessage
      .replace(/\{(mention|username|displayName|server|memberCount|rulesChannel|rolesChannel)\}/g, (_, token: keyof typeof values) => values[token])
      .slice(0, 2_000);
  }

  const guide =
    rules !== null && roles !== null
      ? `Make sure to check out ${rules} and pick your roles in ${roles}.`
      : rules !== null
        ? `Make sure to check out ${rules}.`
        : roles !== null
          ? `Pick your roles in ${roles}.`
          : null;
  return [
    `👋 **Welcome <@${context.memberId}> to Xenon Roleplay!**`,
    ...(guide === null ? [] : ['', guide]),
    '',
    ...(context.memberCount === null ? [] : [`You are our **${ordinal(context.memberCount)} member**!`]),
    'Enjoy your roleplay experience in Xenon. 💚',
  ].join('\n');
}

function liveMemberCount(guild: Guild): number | null {
  return Number.isSafeInteger(guild.memberCount) && guild.memberCount > 0 ? guild.memberCount : null;
}

// ── Role safety ───────────────────────────────────────────────────────────

/** null when the role is a harmless starter role Xenon may assign; otherwise the reason. */
export async function initialRoleProblem(
  guild: Guild,
  role: Role | null,
  state: Pick<DiscordGuildRuntimeState, 'ticketConfig'>,
): Promise<string | null> {
  if (role?.guild.id !== guild.id) return 'That role is not in this server.';
  if (role.id === guild.id) return '@everyone cannot be the initial role.';
  if (role.managed) return 'Bot and integration roles cannot be the initial role.';
  if (role.id === state.ticketConfig?.ticketStaffRoleId) return 'The ticket staff role cannot be the initial role.';
  if (role.permissions.any(PRIVILEGED_PERMISSIONS))
    return 'That role has staff, moderation or administrator permissions, so Xenon will not hand it out.';
  const me = await guild.members.fetchMe();
  if (!me.permissions.has(P.ManageRoles)) return 'Xenon needs the Manage Roles permission to assign it.';
  if (role.position >= me.roles.highest.position) return 'Move the Xenon bot role above that role so Xenon can assign it.';
  return null;
}

// ── Channel resolution ────────────────────────────────────────────────────

interface ResolvedChannel {
  readonly channel: WelcomeChannel | null;
  readonly source: 'configured' | 'adopted' | 'none';
  readonly missing: boolean;
}

/** 1. explicit channelId · 2. adopted `channel.welcome` · 3. none. */
async function resolveWelcomeChannel(guild: Guild, state: DiscordGuildRuntimeState): Promise<ResolvedChannel> {
  const adopted = state.entries.find(
    (entry) => entry.logicalKey === 'channel.welcome' && entry.resourceType === 'CHANNEL',
  )?.discordId;
  const source = state.welcome.channelId !== null ? 'configured' : adopted == null ? 'none' : 'adopted';
  const id = state.welcome.channelId ?? adopted ?? null;
  if (id === null) return { channel: null, source, missing: false };
  const channel = await guild.channels.fetch(id).catch(() => null);
  if (channel?.type === ChannelType.GuildText || channel?.type === ChannelType.GuildAnnouncement)
    return { channel, source, missing: false };
  return { channel: null, source, missing: true };
}

// ── Join ──────────────────────────────────────────────────────────────────

/** GuildMemberAdd handler: exactly one public welcome per member, never fatal. */
export async function handleWelcomeJoin(
  member: GuildMember,
  store: DiscordRuntimeStore,
  deps: WelcomeDeps = defaultDeps,
): Promise<void> {
  if (member.user.bot) return;
  const key = `${member.guild.id}:${member.id}`;
  const now = Date.now();
  for (const [seen, at] of recentJoins) if (now - at > DEDUPE_WINDOW_MS) recentJoins.delete(seen);
  if (recentJoins.has(key)) return;
  recentJoins.set(key, now);

  const state = await store.getGuild(member.guild.id);
  const config = state.welcome;
  if (!config.enabled) return;

  const resolved = await resolveWelcomeChannel(member.guild, state);
  if (resolved.missing) {
    logger.warn({ guildId: member.guild.id, source: resolved.source }, 'Welcome channel is missing; rerun /xenon welcome configure');
  } else if (resolved.channel !== null) {
    await sendPublicWelcome(member, resolved.channel, config, deps).catch((error: unknown) => {
      logger.warn({ guildId: member.guild.id, error: describe(error) }, 'Public welcome could not be sent');
    });
  }
  await assignInitialRole(member, config, state).catch((error: unknown) => {
    logger.warn({ guildId: member.guild.id, error: describe(error) }, 'Initial welcome role could not be assigned');
  });
  if (config.dmEnabled) {
    await member.send({ embeds: [welcomeDmEmbed(member.displayName, config)] }).catch((error: unknown) => {
      logger.debug({ guildId: member.guild.id, error: describe(error) }, 'Welcome DM not delivered');
    });
  }
}

/** The text and card for a member, shared by the real welcome and the preview. */
async function buildWelcome(
  member: GuildMember,
  config: WelcomeConfig,
  deps: WelcomeDeps,
): Promise<{ readonly content: string; readonly files: AttachmentBuilder[] }> {
  const memberCount = config.showMemberCount ? liveMemberCount(member.guild) : null;
  const content = renderWelcomeText(config, {
    memberId: member.id,
    username: member.user.username,
    displayName: member.displayName,
    guildName: member.guild.name,
    memberCount,
  });
  if (!config.generateCard) return { content, files: [] };
  try {
    const avatar = await deps
      .fetchAvatar(member.user.displayAvatarURL({ extension: 'png', size: 256, forceStatic: true }))
      .catch(() => null);
    const card = await deps.renderCard({
      avatar,
      name: cardName(member.displayName, member.user.username),
      memberCount,
    });
    return { content, files: [new AttachmentBuilder(card, { name: 'welcome.png' })] };
  } catch (error) {
    logger.warn({ guildId: member.guild.id, error: describe(error) }, 'Welcome card render failed; sending text only');
    return { content, files: [] };
  }
}

async function sendPublicWelcome(
  member: GuildMember,
  channel: WelcomeChannel,
  config: WelcomeConfig,
  deps: WelcomeDeps,
): Promise<void> {
  const { content, files } = await buildWelcome(member, config, deps);
  const message = await channel.send({
    content,
    files,
    // Only the new member may be pinged: never roles, @everyone or @here.
    allowedMentions: { users: [member.id], roles: [], parse: [] },
  });
  await message.react('💚').catch(() => undefined);
  if (config.deleteAfterSeconds > 0) scheduleDelete(message, config.deleteAfterSeconds);
}

/**
 * In-process timer: a bot restart before it fires leaves the welcome in place.
 * Nothing is persisted, so a restart can never corrupt runtime state.
 */
function scheduleDelete(message: Message, seconds: number): void {
  const delay = Math.min(seconds, MAX_WELCOME_DELETE_SECONDS) * 1_000;
  setTimeout(() => {
    void message.delete().catch(() => undefined);
  }, delay).unref();
}

async function assignInitialRole(member: GuildMember, config: WelcomeConfig, state: DiscordGuildRuntimeState): Promise<void> {
  if (config.initialRoleId === null) return;
  const role = await member.guild.roles.fetch(config.initialRoleId).catch(() => null);
  const problem = await initialRoleProblem(member.guild, role, state);
  if (problem !== null || role === null) {
    logger.warn({ guildId: member.guild.id, problem }, 'Initial welcome role skipped');
    return;
  }
  await member.roles.add(role, 'Xenon welcome initial role');
}

function welcomeDmEmbed(displayName: string, config: WelcomeConfig) {
  const where = (id: string | null) => (id === null ? '' : ` in <#${id}>`);
  return XenonBasePanel({
    title: '👋 WELCOME TO XENON ROLEPLAY',
    description: [
      `Welcome, **${escapeMarkdown(displayName.slice(0, 64))}**.`,
      '',
      'Your story starts here.',
      '',
      `• Read the server rules${where(config.rulesChannelId)}`,
      `• Choose your roles${where(config.rolesChannelId)}`,
      '• Ask the support team if you need help',
      '• Enjoy your time in Xenon',
    ].join('\n'),
    footer: 'Xenon Roleplay',
  }).toJSON();
}

function describe(error: unknown): { readonly code: string | number | null; readonly message: string } {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  return {
    code: typeof code === 'string' || typeof code === 'number' ? code : null,
    message: error instanceof Error ? error.message.slice(0, 200) : 'Unknown error',
  };
}

// ── Intents ───────────────────────────────────────────────────────────────

/** Whether the Developer Portal grants Server Members Intent, required for join events. */
export function membersIntentAvailable(client: Client): boolean {
  return (
    client.application?.flags.any([ApplicationFlags.GatewayGuildMembers, ApplicationFlags.GatewayGuildMembersLimited]) ===
    true
  );
}

// ── Commands ──────────────────────────────────────────────────────────────

export async function handleWelcomeCommand(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
  store: DiscordRuntimeStore,
  subcommand: string,
  deps: WelcomeDeps = defaultDeps,
): Promise<void> {
  if (subcommand === 'configure') {
    await configureWelcome(interaction, guild, store);
    return;
  }
  if (subcommand === 'status') {
    await interaction.reply({ content: await welcomeStatus(interaction, guild, store), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }
  if (subcommand === 'preview') {
    await previewWelcome(interaction, guild, store, deps);
    return;
  }
  const current = (await store.getGuild(guild.id)).welcome;
  const next: WelcomeConfig = {
    ...current,
    enabled: subcommand === 'enable' ? true : subcommand === 'disable' ? false : current.enabled,
    dmEnabled: subcommand === 'dm-enable' ? true : subcommand === 'dm-disable' ? false : current.dmEnabled,
  };
  await store.saveWelcomeConfig(guild.id, next);
  const labels: Record<string, string> = {
    enable: '✅ Xenon welcomes are **enabled**.',
    disable: 'Xenon welcomes are **disabled**. New members will not be greeted.',
    'dm-enable': '✅ Welcome DMs are **enabled**.',
    'dm-disable': 'Welcome DMs are **disabled**.',
  };
  await interaction.reply({ content: labels[subcommand] ?? 'Welcome settings saved.', flags: MessageFlags.Ephemeral });
}

async function configureWelcome(interaction: ChatInputCommandInteraction, guild: Guild, store: DiscordRuntimeStore): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const reject = (reason: string) => interaction.editReply(`${reason} Nothing was saved.`);
  /** Absent option → null; selected but unusable → 'invalid'. */
  const pick = async (name: string, required: boolean): Promise<WelcomeChannel | null | 'invalid'> => {
    const option = interaction.options.getChannel(name, required);
    if (option === null) return null;
    const channel = await guild.channels.fetch(option.id).catch(() => null);
    return channel?.guildId === guild.id && (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement)
      ? channel
      : 'invalid';
  };

  const welcome = await pick('channel', true);
  if (welcome === null || welcome === 'invalid') {
    await reject('channel must be a text or announcement channel in this server.');
    return;
  }
  const rules = await pick('rules_channel', false);
  if (rules === 'invalid') {
    await reject('rules_channel must be a text or announcement channel in this server.');
    return;
  }
  const roles = await pick('roles_channel', false);
  if (roles === 'invalid') {
    await reject('roles_channel must be a text or announcement channel in this server.');
    return;
  }

  const state = await store.getGuild(guild.id);
  const roleOption = interaction.options.getRole('initial_role', false);
  let initialRoleId: string | null = null;
  if (roleOption !== null) {
    const role = await guild.roles.fetch(roleOption.id).catch(() => null);
    const problem = await initialRoleProblem(guild, role, state);
    if (problem !== null || role === null) {
      await reject(`initial_role was rejected: ${problem ?? 'That role is not in this server.'}`);
      return;
    }
    initialRoleId = role.id;
  }

  const message = interaction.options.getString('message', false);
  if (message !== null) {
    const unknown = unknownWelcomeTokens(message);
    if (unknown.length > 0) {
      await reject(`message uses unsupported tokens: ${unknown.map((token) => `{${token}}`).join(', ')}. Allowed: ${WELCOME_TOKENS.map((token) => `{${token}}`).join(', ')}.`);
      return;
    }
  }

  const current = state.welcome;
  const generateCard = interaction.options.getBoolean('generate_card', false) ?? current.generateCard;
  const me = await guild.members.fetchMe();
  const needed = [P.ViewChannel, P.SendMessages, ...(generateCard ? [P.AttachFiles] : [])];
  const missing = welcome.permissionsFor(me).missing(needed);
  if (missing.length > 0) {
    await reject(`Xenon is missing permissions in <#${welcome.id}>: ${missing.join(', ')}.`);
    return;
  }

  const next: WelcomeConfig = {
    enabled: current.enabled,
    channelId: welcome.id,
    dmEnabled: interaction.options.getBoolean('dm_enabled', false) ?? current.dmEnabled,
    rulesChannelId: rules?.id ?? null,
    rolesChannelId: roles?.id ?? null,
    initialRoleId,
    showMemberCount: interaction.options.getBoolean('show_member_count', false) ?? current.showMemberCount,
    generateCard,
    deleteAfterSeconds: Math.min(
      Math.max(0, interaction.options.getInteger('delete_after', false) ?? current.deleteAfterSeconds),
      MAX_WELCOME_DELETE_SECONDS,
    ),
    customMessage: message === null || message.trim().length === 0 ? null : message,
  };
  await store.saveWelcomeConfig(guild.id, next);
  await interaction.editReply({
    content: [
      '✅ **Xenon welcome configured.**',
      '',
      await welcomeStatus(interaction, guild, store),
      '',
      '-# Channels, initial role and message that are not provided are cleared. Toggles not provided keep their current value.',
    ].join('\n'),
    allowedMentions: { parse: [] },
  });
}

export async function welcomeStatus(
  interaction: { readonly client: Client },
  guild: Guild,
  store: DiscordRuntimeStore,
): Promise<string> {
  const state = await store.getGuild(guild.id);
  const config = state.welcome;
  const resolved = await resolveWelcomeChannel(guild, state);
  const onOff = (value: boolean) => (value ? 'ON' : 'OFF');
  const channelLine =
    resolved.source === 'none'
      ? 'not configured'
      : resolved.missing
        ? 'missing — rerun /xenon welcome configure'
        : `<#${resolved.channel?.id ?? ''}>${resolved.source === 'adopted' ? ' (adopted fallback)' : ''}`;
  const readiness = !config.enabled
    ? 'NOT READY — welcomes are disabled. Run /xenon welcome enable.'
    : resolved.source === 'none'
      ? 'NOT READY — configure a welcome channel.'
      : resolved.missing
        ? 'NOT READY — the welcome channel no longer exists. Rerun /xenon welcome configure.'
        : !membersIntentAvailable(interaction.client)
          ? 'NOT READY — enable Server Members Intent in the Discord Developer Portal.'
          : 'READY';
  return [
    '**XENON WELCOME SYSTEM**',
    '',
    `Status: ${config.enabled ? 'ENABLED' : 'DISABLED'}`,
    '',
    `Channel: ${channelLine}`,
    `Rules: ${config.rulesChannelId === null ? 'not set' : `<#${config.rulesChannelId}>`}`,
    `Roles: ${config.rolesChannelId === null ? 'not set' : `<#${config.rolesChannelId}>`}`,
    `Initial role: ${config.initialRoleId === null ? 'none' : `<@&${config.initialRoleId}>`}`,
    '',
    `Welcome card: ${onOff(config.generateCard)}`,
    `Member count: ${onOff(config.showMemberCount)}`,
    `DM welcome: ${onOff(config.dmEnabled)}`,
    `Auto delete: ${config.deleteAfterSeconds === 0 ? 'OFF' : `after ${String(config.deleteAfterSeconds)}s (cancelled if the bot restarts first)`}`,
    `Message: ${config.customMessage === null ? 'Xenon default' : 'custom'}`,
    '',
    'ProBot replacement readiness:',
    readiness,
  ].join('\n');
}

/** Renders the configured welcome for the caller, privately. Changes nothing. */
async function previewWelcome(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
  store: DiscordRuntimeStore,
  deps: WelcomeDeps,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const member = await guild.members.fetch(interaction.user.id);
  const config = (await store.getGuild(guild.id)).welcome;
  const { content, files } = await buildWelcome(member, config, deps);
  const count = liveMemberCount(guild);
  await interaction.editReply({
    content: [
      `-# Preview only — nothing was posted, assigned or sent. Current member count: ${count === null ? 'unavailable' : String(count)}.`,
      '',
      content,
    ].join('\n').slice(0, 2_000),
    files,
    allowedMentions: { parse: [] },
  });
}
