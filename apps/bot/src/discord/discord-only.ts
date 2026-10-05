import {
  ActivityType,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  PermissionFlagsBits as P,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type VoiceBasedChannel,
} from 'discord.js';
import { randomUUID } from 'node:crypto';

import { assetsRoot, desiredAssets, readAssetData, readManifest } from '@xenon/discord/assets';
import { parseXenonId } from '@xenon/discord/interaction-ids';
import { XenonAnnouncementPanel } from '@xenon/discord/panels';
import {
  buildDesiredState,
  executePlan,
  panelHash,
  parseFeatures,
  planGuild,
  planResourceAdoption,
  PROVISION_PHRASE,
  renderPanel,
  type DesiredPanel,
  type EmojiRef,
  type PanelContext,
  type PlanItem,
} from '@xenon/discord/provisioning/pure';

import { adoptionReply } from './adoption-reply';
import {
  ADOPT_CHANNEL_OPTIONS,
  ADOPT_CHANNEL_TYPES,
  DISABLED_PLATFORM_RESPONSE,
  DISCORD_ONLY_COMMANDS,
  isPlatformDataCommand,
  respondPlatformUnavailable,
} from './discord-only-commands';
import { discordGuildAdapter } from './provisioning/guild-adapter';
import { JsonDiscordRuntimeStore, type DiscordGuildRuntimeState, type DiscordRuntimeStore } from './runtime-store';
import { botEnv, logger } from '../runtime';

const MAX_TEMP_ROOMS = 25;
const roomCreationTime = new Map<string, number>();

interface StandaloneContext {
  readonly adapter: ReturnType<typeof discordGuildAdapter>;
  readonly registry: ReturnType<DiscordRuntimeStore['registry']>;
  readonly entries: Awaited<ReturnType<ReturnType<DiscordRuntimeStore['registry']>['list']>>;
  readonly snapshot: Awaited<ReturnType<ReturnType<typeof discordGuildAdapter>['snapshot']>>;
  readonly state: ReturnType<typeof buildDesiredState>;
  readonly plan: ReturnType<typeof planGuild>;
  readonly emojis: ReadonlyMap<string, EmojiRef>;
  readonly panelContext: PanelContext;
  readonly render: (panel: DesiredPanel, emojiMap?: ReadonlyMap<string, EmojiRef>) => ReturnType<typeof renderPanel>;
  readonly readAsset: (asset: { file: string }) => Promise<Buffer>;
}

export async function startDiscordOnlyRuntime(): Promise<void> {
  logger.info('Starting Xenon Discord service');

  const token = botEnv.DISCORD_BOT_TOKEN;
  const applicationId = botEnv.DISCORD_APPLICATION_ID;
  const guildId = botEnv.DISCORD_GUILD_ID;
  if (token === undefined || applicationId === undefined || guildId === undefined)
    throw new Error('Discord-only configuration was not fully validated.');

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates],
    partials: [Partials.User, Partials.Channel],
  });
  const runtimeStore: DiscordRuntimeStore = new JsonDiscordRuntimeStore();

  client.on('error', (error) => logger.error({ err: error }, 'Discord client error'));
  client.on('shardDisconnect', (event, shardId) => {
    logger.warn({ shardId, code: event.code }, 'Discord shard disconnected; reconnecting');
  });
  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand() && !interaction.isButton() && !interaction.isStringSelectMenu()) return;
    void (async () => {
      if (interaction.isChatInputCommand()) {
        await handleCommand(interaction, client, runtimeStore);
      } else if (interaction.isButton()) {
        await handleButton(interaction, runtimeStore);
      } else {
        await interaction.reply({ content: DISABLED_PLATFORM_RESPONSE, flags: MessageFlags.Ephemeral });
      }
    })().catch((error: unknown) => logger.error({ err: error }, 'Discord-only interaction failed'));
  });
  client.on(Events.GuildMemberAdd, (member) => {
    if (member.guild.id !== guildId) return;
    void handleMemberJoin(member, runtimeStore).catch((error: unknown) => {
      logger.warn({ err: error, guildId: member.guild.id }, 'Discord welcome handler failed');
    });
  });
  client.on(Events.VoiceStateUpdate, (before, after) => {
    if (after.guild.id !== guildId) return;
    void handleVoiceState(before.member ?? after.member, before.channel, after.channel, runtimeStore)
      .catch((error: unknown) => logger.warn({ err: error }, 'Temporary voice handling failed'));
  });

  const ready = new Promise<void>((resolveReady) => client.once(Events.ClientReady, () => resolveReady()));
  await client.login(token);
  if (!client.isReady()) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Discord gateway did not become ready in time.')), 30_000);
        }),
      ]);
    } catch (error) {
      await client.destroy();
      throw error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
  if (client.user?.id !== applicationId) {
    await client.destroy();
    throw new Error('DISCORD_APPLICATION_ID does not match the bot account token.');
  }
  logger.info({ user: client.user.tag }, 'Discord connected');

  const guild = await client.guilds.fetch(guildId);
  logger.info({ guildId: guild.id, name: guild.name }, 'Guild resolved');
  logger.info({ shardId: client.shard?.ids[0] ?? 0, latencyMs: client.ws.ping }, 'Gateway READY');

  await guild.commands.set(DISCORD_ONLY_COMMANDS);
  logger.info({ count: DISCORD_ONLY_COMMANDS.length, guildId }, 'Discord slash commands registered');
  await cleanEmptyRooms(guild, runtimeStore);
  client.user.setActivity('XenonRP Discord', { type: ActivityType.Watching });

  logger.info('Discord-only runtime active');
  logger.info('Xenon Discord service ready');

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Stopping Xenon Discord service');
    void client.destroy();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

async function loadContext(guild: Guild, runtimeStore: DiscordRuntimeStore): Promise<StandaloneContext> {
  const adapter = discordGuildAdapter(guild);
  const registry = runtimeStore.registry(guild.id);
  const [entries, saved] = await Promise.all([registry.list(), runtimeStore.getGuild(guild.id)]);
  const panelRefs = entries.flatMap((entry) =>
    entry.resourceType === 'PANEL' && entry.discordId !== null && entry.channelId !== null
      ? [{ channelId: entry.channelId, messageId: entry.discordId }]
      : [],
  );
  const root = assetsRoot();
  const [snapshot, manifest] = await Promise.all([adapter.snapshot(panelRefs), readManifest(root)]);
  const features = parseFeatures(saved.features);
  const blueprint = buildDesiredState({
    features,
    guildFeatures: snapshot.features,
    departments: [],
    organizations: [],
    assets: desiredAssets(manifest, root),
  });
  // Platform backed whitelist review has no data source in this runtime.
  const state = {
    ...blueprint,
    panels: blueprint.panels.map((panel) => ({ ...panel, live: false })),
  };

  const liveEmojiIds = new Set(snapshot.emojis.map((emoji) => emoji.id));
  const emojiMap = new Map<string, EmojiRef>();
  for (const asset of state.assets) {
    const entry = entries.find((candidate) => candidate.logicalKey === asset.key);
    if (asset.type === 'EMOJI' && entry?.discordId !== null && entry?.discordId !== undefined && liveEmojiIds.has(entry.discordId)) {
      emojiMap.set(asset.key, { id: entry.discordId, name: asset.name, animated: asset.animated });
    }
  }

  const selfRoles = state.roles.filter((role) => role.selfAssignable);
  const panelContext: PanelContext = {
    discordOnly: true,
    siteUrl: '',
    linksAllowed: false,
    connectUrl: null,
    rules: { version: null, retrievedAt: null },
    applications: { globallyOpen: false, whitelistOpen: false, open: [] },
    departments: [],
    status: {
      aggregate: 'UNKNOWN',
      totalPlayers: null,
      totalCapacity: null,
      queue: null,
      nextRestartAt: null,
      checkedAt: null,
      servers: [],
    },
    emojis: emojiMap,
    selfRoles,
  };
  const render = (panel: DesiredPanel, emojis: ReadonlyMap<string, EmojiRef> = emojiMap) =>
    renderPanel(panel, { ...panelContext, emojis });
  const panelHashes = new Map(state.panels.map((panel) => [panel.key, panelHash(render(panel))]));
  const plan = planGuild({ state, snapshot, registry: entries, panelHashes, production: true });

  return {
    adapter,
    registry,
    entries,
    snapshot,
    state,
    plan,
    emojis: emojiMap,
    panelContext,
    render,
    readAsset: (asset) => readAssetData(asset, root),
  };
}

export async function handleCommand(
  interaction: ChatInputCommandInteraction,
  client: Client,
  runtimeStore: DiscordRuntimeStore,
): Promise<void> {
  if (interaction.guild === null) {
    await ephemeral(interaction, 'Use this command in the Xenon Discord server.');
    return;
  }
  if (isPlatformDataCommand(interaction.commandName)) {
    await respondPlatformUnavailable(interaction);
    return;
  }
  if (interaction.commandName === 'status') {
    const guild = await client.guilds.fetch(botEnv.DISCORD_GUILD_ID!);
    await ephemeral(
      interaction,
      `Discord gateway: ${client.isReady() ? 'READY' : 'CONNECTING'}\nGuild: ${guild.name}\nRuntime: discord-only`,
    );
    return;
  }
  if (interaction.commandName === 'xenon') {
    await handleXenon(interaction, runtimeStore);
    return;
  }
  if (interaction.commandName === 'room') {
    await handleRoomCommand(interaction, runtimeStore);
    return;
  }
  if (interaction.commandName === 'announce') {
    await handleAnnouncement(interaction, runtimeStore);
    return;
  }
  await ephemeral(interaction, 'This Discord command is not available.');
}

async function handleXenon(
  interaction: ChatInputCommandInteraction,
  runtimeStore: DiscordRuntimeStore,
): Promise<void> {
  if (!isGuildManager(interaction)) {
    await ephemeral(interaction, 'Only the Discord server owner or a member with Manage Server can use this command.');
    return;
  }
  const guild = interaction.guild!;
  const group = interaction.options.getSubcommandGroup(true);
  const subcommand = interaction.options.getSubcommand(true);

  if (group === 'welcome') {
    const current = await runtimeStore.getGuild(guild.id);
    await runtimeStore.saveWelcome(guild.id, {
      welcomeEnabled: subcommand === 'enable' ? true : subcommand === 'disable' ? false : current.welcomeEnabled,
      welcomeDmEnabled: subcommand === 'dm-enable' ? true : subcommand === 'dm-disable' ? false : current.welcomeDmEnabled,
    });
    await ephemeral(interaction, 'Discord welcome settings saved.');
    return;
  }

  const context = await loadContext(guild, runtimeStore);
  if (group === 'automod') {
    if (subcommand === 'status') {
      const settings = await runtimeStore.getGuild(guild.id);
      const rules = context.entries.filter((entry) => entry.resourceType === 'AUTOMOD');
      await ephemeral(interaction, `AutoMod configured: ${String(parseFeatures(settings.features).automod)}\nManaged rules: ${String(rules.length)}`);
      return;
    }
    const enable = subcommand === 'enable';
    const nextFeatures = { ...parseFeatures((await runtimeStore.getGuild(guild.id)).features), automod: enable };
    if (enable) {
      await runtimeStore.saveFeatures(guild.id, nextFeatures);
      const refreshed = await loadContext(guild, runtimeStore);
      const keys = new Set(refreshed.state.automod.map((rule) => rule.key));
      const result = await execute(refreshed, 'apply', keys);
      await ephemeral(interaction, `AutoMod enabled. ${executionSummary(result)}`);
    } else {
      for (const entry of context.entries.filter((candidate) => candidate.resourceType === 'AUTOMOD' && candidate.discordId !== null))
        await context.adapter.setAutoModEnabled(entry.discordId!, false);
      await runtimeStore.saveFeatures(guild.id, nextFeatures);
      await ephemeral(interaction, 'Xenon AutoMod rules are disabled.');
    }
    return;
  }

  if (group === 'setup') {
    if (subcommand === 'plan') {
      await ephemeral(interaction, planSummary(context));
      return;
    }
    if (subcommand === 'status') {
      await ephemeral(interaction, `${String(context.entries.length)} managed Discord resources are recorded. ${planSummary(context)}`);
      return;
    }
    if (subcommand === 'permissions' || subcommand === 'validate') {
      const diagnostics = [...context.plan.blueprintAudit.diagnostics, ...context.plan.liveAudit.diagnostics];
      await ephemeral(interaction, diagnostics.length === 0
        ? `Permission validation passed. ${String(context.plan.counts.unchanged)} resources match the current plan.`
        : diagnostics.slice(0, 8).map((diagnostic) => `${diagnostic.severity.toUpperCase()}: ${diagnostic.message}`).join('\n'));
      return;
    }
    if (subcommand === 'assets') {
      const assets = context.state.assets;
      await ephemeral(interaction, `Curated assets: ${String(assets.length)} enabled\nEmojis: ${String(assets.filter((asset) => asset.type === 'EMOJI').length)}\nStickers: ${String(assets.filter((asset) => asset.type === 'STICKER').length)}`);
      return;
    }
    if (subcommand === 'adopt') {
      await ephemeral(interaction, await adoptRegistryResources(interaction, guild, context));
      return;
    }
    const confirmation = interaction.options.getString('confirm', true);
    if (confirmation !== PROVISION_PHRASE) {
      await ephemeral(interaction, `No changes applied. Type exactly “${PROVISION_PHRASE}” in the confirm option.`);
      return;
    }
    if (!context.plan.blueprintAudit.passed) {
      await ephemeral(interaction, 'The blueprint permission audit failed. Nothing was applied.');
      return;
    }
    const result = await execute(context, subcommand === 'repair' ? 'repair' : 'apply');
    await ephemeral(interaction, executionSummary(result));
    return;
  }

  if (group === 'panel') {
    const panelKeys = new Set(context.state.panels.map((panel) => panel.key));
    if (subcommand === 'status') {
      const panels = context.plan.items.filter((item) => item.resourceType === 'PANEL');
      await ephemeral(interaction, `Persistent Discord panels: ${String(panels.length)}\n${panels.slice(0, 12).map((item) => `${item.key}: ${item.kind.toLowerCase()}`).join('\n')}`);
      return;
    }
    const result = subcommand === 'setup'
      ? await execute(context, 'apply', panelKeys)
      : await execute(context, 'repair', panelKeys);
    await ephemeral(interaction, executionSummary(result));
  }
}

async function execute(
  context: StandaloneContext,
  mode: 'apply' | 'repair',
  onlyKeys?: ReadonlySet<string>,
) {
  return executePlan(
    context.plan.items,
    context.state,
    context.snapshot,
    context.entries,
    context.adapter,
    context.registry,
    {
      mode,
      runId: `discord-${randomUUID()}`,
      blueprintVersion: context.state.version,
      includeSoft: true,
      ...(onlyKeys === undefined ? {} : { onlyKeys }),
      pacingMs: 0,
      renderPanel: (panel, emojis) => context.render(panel, emojis),
      readAsset: context.readAsset,
    },
  );
}

/**
 * Registry-only: binds explicitly selected channels, then exact live matches, in the
 * JSON store. Never calls Discord mutation APIs or the provisioning engine.
 */
async function adoptRegistryResources(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
  context: StandaloneContext,
): Promise<string> {
  const explicit = await resolveExplicitChannels(interaction, guild, context);
  if (typeof explicit === 'string') return explicit;

  for (const selection of explicit) {
    await context.registry.upsert({
      logicalKey: selection.logicalKey,
      resourceType: 'CHANNEL',
      discordId: selection.id,
      channelId: null,
      managed: true,
      contentHash: null,
      configurationHash: null,
      createdByRunId: null,
      metadata: { adopted: true, adoptedFrom: selection.name, source: 'setup-adopt-explicit' },
    });
  }

  const channels = context.snapshot.channels.flatMap(({ id, name, kind }) =>
    kind === 'other' ? [] : [{ id, name, kind }],
  );
  const roles = context.snapshot.roles.map(({ id, name, managed }) => ({ id, name, managed }));
  const entries = explicit.length === 0 ? context.entries : await context.registry.list();
  const plan = planResourceAdoption(context.state, entries, channels, roles);
  for (const resource of plan.adopted) {
    await context.registry.upsert({
      logicalKey: resource.logicalKey,
      resourceType: resource.resourceType,
      discordId: resource.discordId,
      channelId: null,
      managed: true,
      contentHash: null,
      configurationHash: null,
      createdByRunId: null,
      metadata: { adopted: true, adoptedFrom: resource.name, source: 'setup-adopt' },
    });
  }
  return adoptionReply(plan, context.state, explicit);
}

/** Validates every selected option before anything is saved; returns an error message on failure. */
async function resolveExplicitChannels(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
  context: StandaloneContext,
): Promise<{ logicalKey: string; label: string; id: string; name: string }[] | string> {
  const selections: { logicalKey: string; label: string; id: string; name: string }[] = [];
  for (const binding of ADOPT_CHANNEL_OPTIONS) {
    const selected = interaction.options.getChannel(binding.option);
    if (selected === null) continue;
    const channel = await guild.channels.fetch(selected.id).catch(() => null);
    if (
      channel?.guildId !== guild.id ||
      !(ADOPT_CHANNEL_TYPES as readonly ChannelType[]).includes(channel.type) ||
      !channel.isTextBased() ||
      !('send' in channel)
    ) {
      return `${binding.label} must be a text or announcement channel in this server. Nothing was saved.`;
    }
    selections.push({ logicalKey: binding.logicalKey, label: binding.label, id: channel.id, name: channel.name });
  }

  if (new Set(selections.map((selection) => selection.id)).size !== selections.length)
    return 'Each option needs a different channel. Nothing was saved.';
  const explicitKeys = new Set(selections.map((selection) => selection.logicalKey));
  for (const selection of selections) {
    const owner = context.entries.find(
      (entry) => entry.discordId === selection.id && !explicitKeys.has(entry.logicalKey),
    );
    if (owner !== undefined)
      return `#${selection.name} is already mapped to ${owner.logicalKey}. Nothing was saved.`;
  }
  return selections;
}

async function handleButton(
  interaction: import('discord.js').ButtonInteraction,
  runtimeStore: DiscordRuntimeStore,
): Promise<void> {
  const xenonId = parseXenonId(interaction.customId);
  if (xenonId?.namespace !== 'role' || xenonId.action !== 'toggle' || interaction.guild === null || xenonId.argument === null) {
    await ephemeral(interaction, DISABLED_PLATFORM_RESPONSE);
    return;
  }
  const context = await loadContext(interaction.guild, runtimeStore);
  const desiredRole = context.state.roles.find((role) => role.key === xenonId.argument && role.selfAssignable);
  const entry = context.entries.find((candidate) => candidate.logicalKey === xenonId.argument && candidate.resourceType === 'ROLE' && candidate.managed);
  if (desiredRole === undefined || entry?.discordId === null || entry?.discordId === undefined) {
    await ephemeral(interaction, 'That self-role is not currently available.');
    return;
  }
  const role = await interaction.guild.roles.fetch(entry.discordId).catch(() => null);
  const me = await interaction.guild.members.fetchMe();
  if (role === null || role.managed || role.permissions.bitfield !== 0n || role.position >= me.roles.highest.position) {
    await ephemeral(interaction, 'That role is unavailable or is not safe to self-assign.');
    return;
  }
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const hasRole = member.roles.cache.has(role.id);
  await member.roles[hasRole ? 'remove' : 'add'](role, 'Xenon self-role panel');
  await ephemeral(interaction, `${hasRole ? 'Removed' : 'Added'} ${role.name}.`);
}

async function handleMemberJoin(member: GuildMember, runtimeStore: DiscordRuntimeStore): Promise<void> {
  const settings = await runtimeStore.getGuild(member.guild.id);
  if (!settings.welcomeEnabled) return;
  const welcome = settings.entries.find((entry) => entry.logicalKey === 'channel.welcome' && entry.resourceType === 'CHANNEL');
  if (welcome?.discordId !== null && welcome?.discordId !== undefined) {
    const channel = await member.guild.channels.fetch(welcome.discordId).catch(() => null);
    if (channel?.isSendable()) {
      await channel.send({
        content: `Welcome to XenonRP, <@${member.id}>! Read #rules and check #how-to-join to get started.`,
        allowedMentions: { users: [member.id], roles: [], parse: [] },
      });
    }
  }
  if (settings.welcomeDmEnabled) {
    await member.send('Welcome to XenonRP! Read the rules in Discord and ask the staff team if you need help.').catch(() => undefined);
  }
}

async function handleVoiceState(
  member: GuildMember | null,
  beforeChannel: VoiceBasedChannel | null,
  afterChannel: VoiceBasedChannel | null,
  runtimeStore: DiscordRuntimeStore,
): Promise<void> {
  if (member === null) return;
  const guildId = member.guild.id;
  const state = await runtimeStore.getGuild(guildId);
  const lobby = state.entries.find((entry) => entry.logicalKey === 'voice.create-room' && entry.resourceType === 'CHANNEL' && entry.discordId !== null);
  if (lobby !== undefined && afterChannel?.id === lobby.discordId && beforeChannel?.id !== afterChannel.id) {
    await createTemporaryRoom(member, afterChannel, runtimeStore, state);
  }
  if (beforeChannel !== null && beforeChannel.id !== afterChannel?.id && state.rooms[beforeChannel.id] !== undefined) {
    const room = await member.guild.channels.fetch(beforeChannel.id).catch(() => null);
    if (room?.type === ChannelType.GuildVoice && room.members.size === 0) {
      await room.delete('Xenon temporary voice room is empty').catch(() => undefined);
      await runtimeStore.removeRoom(guildId, beforeChannel.id);
    }
  }
}

async function createTemporaryRoom(
  member: GuildMember,
  lobby: VoiceBasedChannel,
  runtimeStore: DiscordRuntimeStore,
  state: DiscordGuildRuntimeState,
): Promise<void> {
  if (!parseFeatures(state.features).tempVoice) return;
  const owned = Object.values(state.rooms).find((room) => room.ownerId === member.id);
  if (owned !== undefined) {
    const existing = await member.guild.channels.fetch(owned.channelId).catch(() => null);
    if (existing?.type === ChannelType.GuildVoice) {
      await member.voice.setChannel(existing, 'Return to your Xenon room');
      return;
    }
    await runtimeStore.removeRoom(member.guild.id, owned.channelId);
  }
  if (Object.keys(state.rooms).length >= MAX_TEMP_ROOMS) {
    await member.voice.disconnect('Xenon temporary room limit reached').catch(() => undefined);
    return;
  }
  const now = Date.now();
  const last = roomCreationTime.get(member.id) ?? 0;
  if (now - last < 30_000) {
    await member.voice.disconnect('Please wait before creating another room').catch(() => undefined);
    return;
  }
  roomCreationTime.set(member.id, now);
  const room = await member.guild.channels.create({
    name: `${member.displayName.slice(0, 24)}'s room`,
    type: ChannelType.GuildVoice,
    parent: lobby.parentId,
    userLimit: 0,
    permissionOverwrites: [{ id: member.id, allow: [P.ViewChannel, P.Connect] }],
    reason: 'Xenon temporary voice room',
  });
  await runtimeStore.saveRoom({
    guildId: member.guild.id,
    channelId: room.id,
    ownerId: member.id,
    createdAt: new Date().toISOString(),
  });
  await member.voice.setChannel(room, 'Created your Xenon room').catch(async () => {
    await room.delete('Owner could not be moved into the room').catch(() => undefined);
    await runtimeStore.removeRoom(member.guild.id, room.id);
  });
}

async function cleanEmptyRooms(guild: Guild, runtimeStore: DiscordRuntimeStore): Promise<void> {
  const state = await runtimeStore.getGuild(guild.id);
  for (const room of Object.values(state.rooms)) {
    const channel = await guild.channels.fetch(room.channelId).catch(() => null);
    if (channel?.type !== ChannelType.GuildVoice || channel.members.size === 0) {
      if (channel?.type === ChannelType.GuildVoice)
        await channel.delete('Removing stale Xenon temporary voice room').catch(() => undefined);
      await runtimeStore.removeRoom(guild.id, room.channelId);
    }
  }
}

async function handleRoomCommand(
  interaction: ChatInputCommandInteraction,
  runtimeStore: DiscordRuntimeStore,
): Promise<void> {
  const guild = interaction.guild!;
  const state = await runtimeStore.getGuild(guild.id);
  const saved = Object.values(state.rooms).find((room) => room.ownerId === interaction.user.id);
  const room = saved === undefined ? null : await guild.channels.fetch(saved.channelId).catch(() => null);
  if (room?.type !== ChannelType.GuildVoice) {
    await ephemeral(interaction, 'You do not own an active Xenon temporary voice room.');
    return;
  }
  const action = interaction.options.getSubcommand();
  if (action === 'rename') {
    await room.setName(sanitiseRoomName(interaction.options.getString('name', true)));
  } else if (action === 'limit') {
    await room.setUserLimit(interaction.options.getInteger('size', true));
  } else if (action === 'lock') {
    await room.permissionOverwrites.edit(guild.roles.everyone, { Connect: false });
  } else if (action === 'unlock') {
    await room.permissionOverwrites.edit(guild.roles.everyone, { Connect: null });
  } else if (action === 'permit') {
    const target = interaction.options.getUser('member', true);
    await room.permissionOverwrites.edit(target, { ViewChannel: true, Connect: true });
  } else if (action === 'remove') {
    const target = interaction.options.getUser('member', true);
    const member = await guild.members.fetch(target.id).catch(() => null);
    if (member?.voice.channelId === room.id) await member.voice.disconnect('Removed from Xenon room');
    await room.permissionOverwrites.edit(target, { Connect: false });
  } else if (action === 'transfer') {
    const target = interaction.options.getUser('member', true);
    const member = await guild.members.fetch(target.id).catch(() => null);
    if (member?.voice.channelId !== room.id) {
      await ephemeral(interaction, 'The new owner must be in your room.');
      return;
    }
    await runtimeStore.saveRoom({ ...saved!, ownerId: target.id });
  }
  await ephemeral(interaction, `Room ${action} complete.`);
}

async function handleAnnouncement(
  interaction: ChatInputCommandInteraction,
  runtimeStore: DiscordRuntimeStore,
): Promise<void> {
  if (!isGuildManager(interaction)) {
    await ephemeral(interaction, 'Only the Discord server owner or a member with Manage Server can post announcements.');
    return;
  }
  const entry = (await runtimeStore.getGuild(interaction.guild!.id)).entries.find(
    (candidate) => candidate.logicalKey === 'channel.announcements' && candidate.resourceType === 'CHANNEL',
  );
  const channel = entry?.discordId === null || entry?.discordId === undefined
    ? null
    : await interaction.guild!.channels.fetch(entry.discordId).catch(() => null);
  if (channel?.isTextBased() !== true || !('send' in channel)) {
    await ephemeral(interaction, 'The announcements channel is not mapped. Run /xenon setup adopt and select an announcements channel.');
    return;
  }
  const embed = XenonAnnouncementPanel({
    type: 'COMMUNITY',
    title: interaction.options.getString('title', true),
    message: interaction.options.getString('message', true),
  });
  await channel.send({ embeds: [embed.toJSON()], allowedMentions: { parse: [] } });
  await ephemeral(interaction, 'Announcement posted.');
}

function isGuildManager(interaction: ChatInputCommandInteraction): boolean {
  return interaction.guild?.ownerId === interaction.user.id || interaction.memberPermissions?.has(P.ManageGuild) === true;
}

function sanitiseRoomName(raw: string): string {
  const value = raw.normalize('NFKC').replace(/[\p{C}@#`*_~|<>]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 32);
  return value.length >= 2 ? value : 'Room';
}

function planSummary(context: StandaloneContext): string {
  const counts = context.plan.counts;
  const changes = context.plan.items
    .filter((item) => item.kind !== 'UNCHANGED')
    .slice(0, 8)
    .map((item) => `${item.kind}: ${item.label}`);
  return [
    `Discord plan for ${context.plan.guildName}`,
    `Create ${counts.create} · update ${counts.update} · permission ${counts.permission} · drift ${counts.drift} · conflicts ${counts.conflict}`,
    ...changes,
  ].join('\n');
}

function executionSummary(result: Awaited<ReturnType<typeof executePlan>>): string {
  const messages = [
    `Applied ${String(result.applied.length)} Discord changes.`,
    result.failed.length === 0 ? '' : `Failed: ${result.failed.slice(0, 4).map((entry) => `${entry.key} (${entry.message})`).join('; ')}`,
    result.skipped.length === 0 ? '' : `Skipped: ${String(result.skipped.length)} items.`,
  ].filter(Boolean);
  return messages.join('\n');
}

function ephemeral(interaction: ChatInputCommandInteraction | import('discord.js').ButtonInteraction, content: string) {
  return interaction.reply({ content: content.slice(0, 1900), flags: MessageFlags.Ephemeral });
}
