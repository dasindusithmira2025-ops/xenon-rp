import {
  ChannelType,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits as P,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type NonThreadGuildBasedChannel,
} from 'discord.js';

import {
  createCase,
  maySetTrust,
  type CaseAction,
  type IncidentStatus,
  type LinkAction,
  type PermissionFinding,
  type SecurityConfig,
  type SecurityIncident,
  type SecuritySeverity,
  type TrustLevel,
  type EnforcementMode,
  type SecurityGuildState,
} from './model';
import {
  permissionCheck,
  PUBLIC_EXCLUSION,
  trustForActor,
  type NativeSafetyCheck,
  type SecurityService,
  enforcedProtections,
} from './service';
import {
  collectGuildFacts,
  compareSnapshot,
  DANGEROUS_BITS,
  describeDiscordError,
  formatComparison,
  restoreRolePermissions,
} from './snapshot';

import type { DiscordRuntimeStore } from '../runtime-store';

const TRUST_CHOICES = [
  { name: 'Security admin', value: 'SECURITY_ADMIN' },
  { name: 'Trusted staff', value: 'TRUSTED_STAFF' },
  { name: 'Normal staff', value: 'NORMAL_STAFF' },
  { name: 'Untrusted', value: 'UNTRUSTED' },
] as const;
const LINK_CHOICES = [
  { name: 'Allow', value: 'ALLOW' },
  { name: 'Warn', value: 'WARN' },
  { name: 'Block', value: 'BLOCK' },
] as const;

const security = new SlashCommandBuilder()
  .setName('security')
  .setDescription('Configure and operate Xenon server security')
  .setDefaultMemberPermissions(null)
  .addSubcommand((sub) =>
    sub
      .setName('setup')
      .setDescription(
        'Idempotently identify or create security channels and an optional quarantine marker',
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('status').setDescription('Show security health and protection status'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('scan')
      .setDescription('Report security and permission risks without changing them'),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('raid')
      .setDescription('Control and inspect raid protection')
      .addSubcommand((sub) =>
        sub.setName('status').setDescription('Show current raid detector state'),
      )
      .addSubcommand((sub) =>
        sub.setName('enable').setDescription('Enable automatic raid detection'),
      )
      .addSubcommand((sub) =>
        sub.setName('disable').setDescription('Disable automatic raid detection'),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('raid-mode')
      .setDescription('Set automatic or manual raid mode')
      .addSubcommand((sub) => sub.setName('on').setDescription('Force raid protections on'))
      .addSubcommand((sub) => sub.setName('off').setDescription('Force raid protections off'))
      .addSubcommand((sub) =>
        sub.setName('auto').setDescription('Return raid protection to automatic mode'),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('trust')
      .setDescription('Manage Xenon security trust levels')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Assign an internal trust level')
          .addUserOption((option) =>
            option.setName('user').setDescription('Trusted actor').setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName('level')
              .setDescription('Internal trust level')
              .setRequired(true)
              .addChoices(...TRUST_CHOICES),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove internal trust')
          .addUserOption((option) =>
            option.setName('user').setDescription('Actor').setRequired(true),
          ),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('List configured trusted actors')),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('automod')
      .setDescription('Reconcile Xenon-owned Discord AutoMod rules')
      .addSubcommand((sub) => sub.setName('status').setDescription('Show native AutoMod rules'))
      .addSubcommand((sub) =>
        sub.setName('sync').setDescription('Create or update only identified Xenon-owned rules'),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('config')
      .setDescription('Update persisted Xenon security policy')
      .addSubcommand((sub) =>
        sub
          .setName('channels')
          .setDescription('Set security log channels')
          .addChannelOption((option) =>
            option
              .setName('alerts')
              .setDescription('High/critical security alerts')
              .addChannelTypes(ChannelType.GuildText),
          )
          .addChannelOption((option) =>
            option
              .setName('audit')
              .setDescription('Security audit and AutoMod evidence')
              .addChannelTypes(ChannelType.GuildText),
          )
          .addChannelOption((option) =>
            option
              .setName('mod_logs')
              .setDescription('Moderation case log')
              .addChannelTypes(ChannelType.GuildText),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('link-policy')
          .setDescription('Configure the local link policy and a domain list')
          .addStringOption((option) =>
            option
              .setName('action')
              .setDescription('Default action for unlisted URLs')
              .setRequired(true)
              .addChoices(...LINK_CHOICES),
          )
          .addStringOption((option) =>
            option
              .setName('domain')
              .setDescription('Optional hostname to trust, block, or remove')
              .setMaxLength(253),
          )
          .addStringOption((option) =>
            option
              .setName('domain_policy')
              .setDescription('Trusted, blocked, or remove from both lists')
              .addChoices(
                { name: 'Trusted', value: 'TRUSTED' },
                { name: 'Blocked', value: 'BLOCKED' },
                { name: 'Remove from both lists', value: 'REMOVE' },
              ),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('raid-thresholds')
          .setDescription('Set increasing join-count thresholds')
          .addIntegerOption((option) =>
            option
              .setName('warning10s')
              .setDescription('Warning count / 10 seconds')
              .setMinValue(1)
              .setMaxValue(1_000)
              .setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName('raid10s')
              .setDescription('Raid count / 10 seconds')
              .setMinValue(2)
              .setMaxValue(1_000)
              .setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName('critical10s')
              .setDescription('Critical count / 10 seconds')
              .setMinValue(3)
              .setMaxValue(1_000)
              .setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName('warning30s')
              .setDescription('Warning count / 30 seconds')
              .setMinValue(1)
              .setMaxValue(2_000)
              .setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName('raid30s')
              .setDescription('Raid count / 30 seconds')
              .setMinValue(2)
              .setMaxValue(2_000)
              .setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName('critical30s')
              .setDescription('Critical count / 30 seconds')
              .setMinValue(3)
              .setMaxValue(2_000)
              .setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName('recovery_minutes')
              .setDescription('Quiet minutes before automatic raid response is released')
              .setMinValue(1)
              .setMaxValue(1_440),
          )
          .addIntegerOption((option) =>
            option
              .setName('slowmode_seconds')
              .setDescription('Raid slowmode seconds (0 disables)')
              .setMinValue(0)
              .setMaxValue(21_600),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('spam')
          .setDescription('Set custom spam thresholds and exemptions')
          .addIntegerOption((option) =>
            option
              .setName('messages_per_8s')
              .setDescription('Flood threshold / 8 seconds')
              .setMinValue(2)
              .setMaxValue(100),
          )
          .addIntegerOption((option) =>
            option
              .setName('duplicates')
              .setDescription('Identical-message threshold')
              .setMinValue(2)
              .setMaxValue(20),
          )
          .addIntegerOption((option) =>
            option
              .setName('mention_limit')
              .setDescription('Mention threshold per message')
              .setMinValue(1)
              .setMaxValue(50),
          )
          .addIntegerOption((option) =>
            option
              .setName('links_per_30s')
              .setDescription('Link threshold / 30 seconds')
              .setMinValue(2)
              .setMaxValue(100),
          )
          .addIntegerOption((option) =>
            option
              .setName('emoji_limit')
              .setDescription('Emoji threshold per message')
              .setMinValue(1)
              .setMaxValue(100),
          )
          .addStringOption((option) =>
            option
              .setName('exemption_action')
              .setDescription('Add or remove the selected exemption')
              .addChoices({ name: 'Add', value: 'ADD' }, { name: 'Remove', value: 'REMOVE' }),
          )
          .addRoleOption((option) =>
            option.setName('exempt_role').setDescription('Optional spam-exempt role'),
          )
          .addChannelOption((option) =>
            option
              .setName('exempt_channel')
              .setDescription('Optional spam-exempt message channel')
              .addChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement,
                ChannelType.GuildForum,
              ),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('keyword')
          .setDescription('Add or remove a deterministic AutoMod keyword')
          .addStringOption((option) =>
            option
              .setName('operation')
              .setDescription('Add or remove the keyword')
              .setRequired(true)
              .addChoices({ name: 'Add', value: 'ADD' }, { name: 'Remove', value: 'REMOVE' }),
          )
          .addStringOption((option) =>
            option
              .setName('value')
              .setDescription('Keyword phrase')
              .setRequired(true)
              .setMinLength(2)
              .setMaxLength(60),
          ),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('snapshot')
      .setDescription('Take, compare, and assist restoring security snapshots')
      .addSubcommand((sub) =>
        sub.setName('take').setDescription('Save a snapshot of roles, channels, and policy'),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('List the latest snapshots'))
      .addSubcommand((sub) =>
        sub
          .setName('compare')
          .setDescription('Compare a snapshot with the live server')
          .addIntegerOption((option) =>
            option
              .setName('index')
              .setDescription('Snapshot index from the list (1 = latest)')
              .setMinValue(1)
              .setMaxValue(10),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('restore-permissions')
          .setDescription('Restore role permission bitfields from the latest snapshot')
          .addBooleanOption((option) =>
            option
              .setName('confirm')
              .setDescription('Apply the changes; omit or false for a dry run'),
          ),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('incident')
      .setDescription('Review and resolve security incidents')
      .addSubcommand((sub) =>
        sub
          .setName('list')
          .setDescription('List recent security incidents')
          .addStringOption((option) =>
            option
              .setName('status')
              .setDescription('Filter by status')
              .addChoices(
                { name: 'Open', value: 'OPEN' },
                { name: 'Contained', value: 'CONTAINED' },
                { name: 'Resolved', value: 'RESOLVED' },
              ),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('view')
          .setDescription('Show the full detail of one incident')
          .addStringOption((option) =>
            option.setName('id').setDescription('Incident ID').setRequired(true).setMaxLength(80),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('resolve')
          .setDescription('Mark an incident resolved with a note')
          .addStringOption((option) =>
            option.setName('id').setDescription('Incident ID').setRequired(true).setMaxLength(80),
          )
          .addStringOption((option) =>
            option
              .setName('note')
              .setDescription('Resolution note')
              .setRequired(true)
              .setMaxLength(500),
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('lockdown')
      .setDescription('Snapshot and lock configured public channels')
      .addStringOption((option) =>
        option
          .setName('reason')
          .setDescription('Reason recorded in the incident log')
          .setRequired(true)
          .setMaxLength(500),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('unlock').setDescription('Restore the captured lockdown overwrites'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('quarantine')
      .setDescription('Apply member-specific quarantine restrictions')
      .addUserOption((option) =>
        option.setName('member').setDescription('Member to quarantine').setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('reason')
          .setDescription('Reason recorded with the case')
          .setRequired(true)
          .setMaxLength(500),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('unquarantine')
      .setDescription('Remove Xenon-owned member-specific quarantine restrictions')
      .addUserOption((option) =>
        option.setName('member').setDescription('Member to release').setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('reason')
          .setDescription('Reason recorded with the case')
          .setRequired(true)
          .setMaxLength(500),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('mode')
      .setDescription('View or change the security enforcement mode')
      .addSubcommand((sub) =>
        sub.setName('status').setDescription('Show the enforcement mode and active restrictions'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('Set observe, alert, or enforce')
          .addStringOption((option) =>
            option
              .setName('mode')
              .setDescription('Enforcement mode')
              .setRequired(true)
              .addChoices(
                { name: 'Observe', value: 'observe' },
                { name: 'Alert', value: 'alert' },
                { name: 'Enforce', value: 'enforce' },
              ),
          )
          .addBooleanOption((option) =>
            option.setName('confirm').setDescription('Required to enable enforce'),
          ),
      ),
  );

export const SECURITY_COMMANDS = [
  security.toJSON(),
  new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Issue a documented warning')
    .setDefaultMemberPermissions(P.ManageMessages)
    .addUserOption((option) =>
      option.setName('member').setDescription('Member to warn').setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('reason')
        .setDescription('Reason for the warning')
        .setRequired(true)
        .setMaxLength(500),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('warnings')
    .setDescription('Show a member’s warning cases')
    .setDefaultMemberPermissions(P.ModerateMembers)
    .addUserOption((option) => option.setName('member').setDescription('Member').setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Timeout a member with a case record')
    .setDefaultMemberPermissions(P.ModerateMembers)
    .addUserOption((option) => option.setName('member').setDescription('Member').setRequired(true))
    .addIntegerOption((option) =>
      option
        .setName('minutes')
        .setDescription('Duration in minutes (1–40320)')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(40_320),
    )
    .addStringOption((option) =>
      option
        .setName('reason')
        .setDescription('Reason for the timeout')
        .setRequired(true)
        .setMaxLength(500),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('untimeout')
    .setDescription('Remove a member timeout')
    .setDefaultMemberPermissions(P.ModerateMembers)
    .addUserOption((option) => option.setName('member').setDescription('Member').setRequired(true))
    .addStringOption((option) =>
      option
        .setName('reason')
        .setDescription('Reason for removal')
        .setRequired(true)
        .setMaxLength(500),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kick a member with a case record')
    .setDefaultMemberPermissions(P.KickMembers)
    .addUserOption((option) => option.setName('member').setDescription('Member').setRequired(true))
    .addStringOption((option) =>
      option
        .setName('reason')
        .setDescription('Reason for the kick')
        .setRequired(true)
        .setMaxLength(500),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a member with a case record')
    .setDefaultMemberPermissions(P.BanMembers)
    .addUserOption((option) => option.setName('member').setDescription('Member').setRequired(true))
    .addStringOption((option) =>
      option
        .setName('reason')
        .setDescription('Reason for the ban')
        .setRequired(true)
        .setMaxLength(500),
    )
    .addIntegerOption((option) =>
      option
        .setName('delete_days')
        .setDescription('Delete recent message days (0–7)')
        .setMinValue(0)
        .setMaxValue(7),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Unban a user by Discord ID')
    .setDefaultMemberPermissions(P.BanMembers)
    .addStringOption((option) =>
      option
        .setName('user_id')
        .setDescription('17–20 digit Discord user ID')
        .setRequired(true)
        .setMinLength(17)
        .setMaxLength(20),
    )
    .addStringOption((option) =>
      option
        .setName('reason')
        .setDescription('Reason for the unban')
        .setRequired(true)
        .setMaxLength(500),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('softban')
    .setDescription('Ban then unban to remove recent messages')
    .setDefaultMemberPermissions(P.BanMembers)
    .addUserOption((option) => option.setName('member').setDescription('Member').setRequired(true))
    .addStringOption((option) =>
      option
        .setName('reason')
        .setDescription('Reason for the softban')
        .setRequired(true)
        .setMaxLength(500),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Bulk-delete recent messages')
    .setDefaultMemberPermissions(P.ManageMessages)
    .addIntegerOption((option) =>
      option
        .setName('amount')
        .setDescription('Number of messages (1–100)')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(100),
    )
    .addStringOption((option) =>
      option
        .setName('reason')
        .setDescription('Reason for the purge')
        .setRequired(true)
        .setMaxLength(500),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('case')
    .setDescription('Read a staff-only moderation case')
    .setDefaultMemberPermissions(P.ModerateMembers)
    .addStringOption((option) =>
      option.setName('id').setDescription('Moderation case ID').setRequired(true).setMaxLength(80),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('cases')
    .setDescription('List cases for a member')
    .setDefaultMemberPermissions(P.ModerateMembers)
    .addUserOption((option) =>
      option.setName('member').setDescription('Filter to a member').setRequired(false),
    )
    .toJSON(),
];

export async function handleSecurityCommand(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
  store: DiscordRuntimeStore,
  service: SecurityService,
): Promise<void> {
  const state = await store.getGuild(guild.id);
  const config = state.security.config;
  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand(true);
  const requiredPermission = ['lockdown', 'unlock', 'quarantine', 'unquarantine'].includes(
    subcommand,
  )
    ? P.ManageChannels
    : P.ManageGuild;
  const minimumTrust: TrustLevel =
    subcommand === 'quarantine' ||
    subcommand === 'unquarantine' ||
    (group === 'incident' && subcommand !== 'resolve')
      ? 'TRUSTED_STAFF'
      : 'SECURITY_ADMIN';
  if (!authorize(interaction, guild, config, requiredPermission, minimumTrust)) {
    await reply(
      interaction,
      'Not authorized. This command requires both the matching Discord permission and Xenon internal trust.',
    );
    return;
  }
  return service.runManual(interaction.user.id, async () => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (group === null && subcommand === 'setup') {
      await reply(
        interaction,
        `${await setupSecurity(guild, store, service, interaction.user.id)}\nEnforcement mode: ${config.enforcementMode}. Automatic responses stay off until /security mode set mode:enforce confirm:true.`,
      );
      return;
    }
    if (group === null && subcommand === 'status') {
      const embed = await securityStatus(guild, state.security, service);
      await interaction.editReply({ content: '', embeds: [embed] });
      return;
    }
    if (group === null && subcommand === 'scan') {
      const findings = await service.scanPermissions(guild);
      if (findings.length === 0) {
        await reply(
          interaction,
          'No configured permission findings. Manual Discord verification-level, 2FA, screening, and raid protection still require owner review.',
        );
        return;
      }
      const { content, embeds } = renderScan(findings);
      await interaction.editReply({ content, embeds });
      return;
    }
    if (group === 'snapshot') {
      const newestFirst = [...state.security.snapshots].reverse().slice(0, 10);
      if (subcommand === 'take') {
        try {
          const taken = await service.saveSnapshot(guild);
          await reply(
            interaction,
            `Snapshot saved at ${taken.createdAt}: ${String(taken.roles.length)} roles, ${String(taken.channels.length)} channels with overwrites.`,
          );
        } catch {
          await reply(interaction, 'Snapshot could not be saved; nothing was changed.');
        }
        return;
      }
      if (subcommand === 'list') {
        await reply(
          interaction,
          newestFirst.length === 0
            ? 'No snapshots recorded. Use /security snapshot take.'
            : newestFirst
                .map(
                  (item, position) =>
                    `${String(position + 1)}. ${item.createdAt} · ${String(item.roles.length)} roles · ${String(item.channels.length)} channels`,
                )
                .join('\n'),
        );
        return;
      }
      const index = subcommand === 'compare' ? (interaction.options.getInteger('index') ?? 1) : 1;
      const chosen = newestFirst[index - 1];
      if (chosen === undefined) {
        await reply(interaction, 'No snapshot exists at that index. Use /security snapshot list.');
        return;
      }
      if (subcommand === 'compare') {
        await reply(
          interaction,
          fit(
            formatComparison(compareSnapshot(chosen, collectGuildFacts(guild)), chosen.createdAt),
          ),
        );
        return;
      }
      if (subcommand === 'restore-permissions') {
        const confirm = interaction.options.getBoolean('confirm') ?? false;
        await reply(
          interaction,
          fit(
            await restoreRolePermissions(
              guild,
              store,
              service,
              interaction.user.id,
              chosen,
              confirm,
            ),
          ),
        );
        return;
      }
    }
    if (group === 'incident') {
      if (subcommand === 'list') {
        const status = interaction.options.getString('status') as IncidentStatus | null;
        const matches = state.security.incidents
          .filter((incident) => status === null || incident.status === status)
          .slice(-15)
          .reverse();
        await reply(
          interaction,
          matches.length === 0
            ? 'No matching incidents.'
            : fit(
                matches
                  .map(
                    (incident) =>
                      `${incident.id} · ${incident.severity} · ${incident.status} · ${incident.title} · ${incident.createdAt}`,
                  )
                  .join('\n'),
              ),
        );
        return;
      }
      const incidentId = interaction.options.getString('id', true);
      if (subcommand === 'view') {
        const found = state.security.incidents.find((incident) => incident.id === incidentId);
        await reply(
          interaction,
          found === undefined ? 'Incident not found.' : fit(formatIncident(found)),
        );
        return;
      }
      if (subcommand === 'resolve') {
        const outcome = await service.resolveIncident(
          guild,
          incidentId,
          interaction.user.id,
          interaction.options.getString('note', true),
        );
        await reply(
          interaction,
          outcome === 'RESOLVED'
            ? `Incident ${incidentId} resolved.`
            : outcome === 'ALREADY_RESOLVED'
              ? `Incident ${incidentId} was already resolved.`
              : 'Incident not found.',
        );
        return;
      }
    }
    if (group === 'mode') {
      await handleModeCommand(interaction, guild, state.security, service);
      return;
    }
    if (group === 'raid') {
      if (subcommand === 'status') {
        const live = await service.raidStatus(guild.id).catch(() => null);
        await reply(
          interaction,
          `Raid detection: ${config.modules.raid ? 'ENABLED' : 'DISABLED'}\nMode: ${config.raidMode}\nJoin thresholds: ${String(config.raidThresholds.warning10s)}/${String(config.raidThresholds.raid10s)}/${String(config.raidThresholds.critical10s)} in 10s; ${String(config.raidThresholds.warning30s)}/${String(config.raidThresholds.raid30s)}/${String(config.raidThresholds.critical30s)} in 30s.\nRecovery after ${String(config.raidRecoveryMinutes)} quiet minutes; raid slowmode ${config.raidSlowmodeSeconds === 0 ? 'disabled' : `${String(config.raidSlowmodeSeconds)}s`}.\n${
            live === null
              ? 'Live state: UNAVAILABLE'
              : `Live level: ${live.level} · joins ${String(live.joins10s)}/10s, ${String(live.joins30s)}/30s · new-account ratio ${live.newAccountRatio.toFixed(2)} · active since ${live.activeSince ?? 'n/a'} · slowmode channels ${String(live.slowmodeChannels)} · recovery at ${live.recoveryAt ?? 'n/a'}`
          }`,
        );
        return;
      }
      await updateConfig(guild, store, service, (current) => ({
        ...current,
        modules: { ...current.modules, raid: subcommand === 'enable' },
        raidMode: subcommand === 'enable' ? 'AUTO' : current.raidMode,
      }));
      const released = await service.checkRaidRecovery(guild).catch(() => false);
      await reply(
        interaction,
        `Raid detection ${subcommand === 'enable' ? 'enabled' : 'disabled'}.${released ? ' Active raid response was released.' : ''}`,
      );
      return;
    }
    if (group === 'raid-mode') {
      const mode = subcommand === 'on' ? 'ON' : subcommand === 'off' ? 'OFF' : 'AUTO';
      await updateConfig(guild, store, service, (current) => ({
        ...current,
        raidMode: mode,
        modules: { ...current.modules, raid: mode === 'ON' || current.modules.raid },
      }));
      await service.recordManualRaidMode(guild, interaction.user.id, mode);
      const released = await service.checkRaidRecovery(guild).catch(() => false);
      await reply(
        interaction,
        `Raid mode set to ${mode}.${released ? ' Active raid response was released.' : ''}`,
      );
      return;
    }
    if (group === 'trust') {
      const target = interaction.options.getUser('user');
      if (subcommand === 'list') {
        const records = [
          `<@${guild.ownerId}> — OWNER (implicit, not assignable)`,
          ...Object.entries(config.trustedActors).map(
            ([userId, trust]) => `<@${userId}> — ${trust}`,
          ),
        ];
        await reply(interaction, records.slice(0, 50).join('\n'));
        return;
      }
      if (target === null) {
        await reply(interaction, 'The required user is missing.');
        return;
      }
      const level =
        subcommand === 'remove'
          ? null
          : (interaction.options.getString('level', true) as TrustLevel);
      await service.saveSnapshot(guild);
      let updateCount = 0;
      await store.updateGuild(guild.id, (current) => {
        const trustedActors: Record<string, TrustLevel> = Object.fromEntries(
          Object.entries(current.security.config.trustedActors).filter(
            ([userId]) => userId !== target.id,
          ),
        );
        const actorTrust = current.security.config.trustedActors[interaction.user.id];
        const targetTrust = current.security.config.trustedActors[target.id];
        if (
          !maySetTrust(
            guild.ownerId === interaction.user.id,
            actorTrust,
            level ?? 'UNTRUSTED',
            targetTrust,
          )
        )
          return current;
        if (level !== null) trustedActors[target.id] = level;
        updateCount += 1;
        return {
          ...current,
          security: {
            ...current.security,
            config: { ...current.security.config, trustedActors },
          },
        };
      });
      if (updateCount === 0) {
        await reply(
          interaction,
          'Trust was not changed: only the owner or a security admin may change trust; the owner alone may change SECURITY_ADMIN trust.',
        );
        return;
      }
      await reply(
        interaction,
        level === null
          ? `Removed Xenon trust for <@${target.id}>.`
          : `Set <@${target.id}> to ${level}.`,
      );
      return;
    }
    if (group === 'automod') {
      if (subcommand === 'status') {
        const rules = await guild.autoModerationRules.fetch();
        const xenonIds = new Set(config.ownedAutoModRuleIds);
        const ownedRules = [...rules.values()].filter((rule) => xenonIds.has(rule.id));
        const unownedXenonRules = [...rules.values()].filter(
          (rule) => rule.name.startsWith('XENON |') && !xenonIds.has(rule.id),
        );
        await reply(
          interaction,
          `Recorded Xenon-owned rules: ${ownedRules.length}/${config.ownedAutoModRuleIds.length}\n${ownedRules.map((rule) => `${rule.name} · ${rule.enabled ? 'enabled' : 'disabled'} · ${rule.id}`).join('\n') || 'None recorded'}\nUnowned same-prefix rules are left untouched: ${
            unownedXenonRules
              .map((rule) => rule.name)
              .slice(0, 10)
              .join(', ') || 'none'
          }`,
        );
        return;
      }
      const result = await service.syncAutoMod(guild);
      await reply(
        interaction,
        `Created: ${result.created.join(', ') || 'none'}\nUpdated: ${result.updated.join(', ') || 'none'}\nConflicts: ${result.conflicts.join('; ') || 'none'}`,
      );
      return;
    }
    if (group === 'config') {
      const updated = await configure(guild, interaction, store, service, config, subcommand);
      await reply(interaction, updated);
      return;
    }
    if (group === null && subcommand === 'lockdown') {
      const reason = interaction.options.getString('reason', true);
      await reply(
        interaction,
        await service.activateLockdown(guild, reason, null, false, interaction.user.id),
      );
      return;
    }
    if (group === null && subcommand === 'unlock') {
      const result = await service.releaseLockdown(guild, interaction.user.id);
      await reply(
        interaction,
        `Restored ${String(result.restored)} channels. ${result.conflicts.slice(0, 8).join('\n')}`.slice(
          0,
          1_900,
        ),
      );
      return;
    }
    if (group === null && (subcommand === 'quarantine' || subcommand === 'unquarantine')) {
      const user = interaction.options.getUser('member', true);
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (member === null) {
        await reply(interaction, 'Member is not available in this guild.');
        return;
      }
      if (!(await moderatorOutranksTarget(guild, interaction.user.id, member))) {
        await reply(interaction, 'Your highest role must strictly outrank the target member.');
        return;
      }
      const reason = interaction.options.getString('reason', true);
      const result =
        subcommand === 'quarantine'
          ? await service.quarantine(member, reason, interaction.user.id)
          : await service.unquarantine(member, interaction.user.id, reason);
      await reply(interaction, result);
      return;
    }
    await reply(interaction, 'Unsupported security command.');
  });
}

export async function handleModerationCommand(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
  store: DiscordRuntimeStore,
  service: SecurityService,
): Promise<void> {
  const config = (await store.getGuild(guild.id)).security.config;
  const command = interaction.commandName;
  const requiredPermission = ['warn', 'purge'].includes(command)
    ? P.ManageMessages
    : ['kick'].includes(command)
      ? P.KickMembers
      : ['ban', 'unban', 'softban'].includes(command)
        ? P.BanMembers
        : P.ModerateMembers;
  if (!authorize(interaction, guild, config, requiredPermission, 'NORMAL_STAFF')) {
    await reply(
      interaction,
      'Not authorized. This action requires both its Discord permission and Xenon NORMAL_STAFF-or-higher trust.',
    );
    return;
  }
  return service.runManual(interaction.user.id, async () => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (command === 'cases' || command === 'warnings') {
      const target =
        command === 'warnings'
          ? interaction.options.getUser('member', true)
          : interaction.options.getUser('member');
      const records = (await store.getGuild(guild.id)).security.cases
        .filter((record) => target === null || record.targetId === target.id)
        .filter((record) => command !== 'warnings' || record.action === 'WARN');
      await reply(
        interaction,
        records.length === 0
          ? 'No matching moderation cases.'
          : records.slice(-15).reverse().map(formatCaseSummary).join('\n').slice(0, 1_900),
      );
      return;
    }
    if (command === 'case') {
      const id = interaction.options.getString('id', true);
      const record = (await store.getGuild(guild.id)).security.cases.find((item) => item.id === id);
      await reply(
        interaction,
        record === undefined ? 'Case not found.' : formatCaseDetails(record),
      );
      return;
    }
    const caseAction = MODERATION_ACTIONS[command];
    if (caseAction === undefined) {
      await reply(interaction, 'Unsupported moderation command.');
      return;
    }
    const botRequirement = BOT_REQUIREMENTS[command];
    if (botRequirement !== undefined) {
      const me = guild.members.me;
      if (!me?.permissions.has(botRequirement.flag)) {
        await reply(
          interaction,
          `Xenon is missing the ${botRequirement.name} permission, so nothing was attempted and no case was recorded.`,
        );
        return;
      }
    }
    if (command === 'purge') {
      const amount = interaction.options.getInteger('amount', true);
      const reason = interaction.options.getString('reason', true);
      const channel = interaction.channel;
      if (channel === null || !channel.isTextBased() || !('bulkDelete' in channel)) {
        await reply(interaction, 'Purge is available only in a standard text channel.');
        return;
      }
      const channelPermissions =
        guild.members.me === null ? null : channel.permissionsFor(guild.members.me);
      if (!channelPermissions?.has([P.ViewChannel, P.ReadMessageHistory, P.ManageMessages])) {
        await reply(
          interaction,
          'Xenon lacks View Channel, Read Message History, or Manage Messages in this channel, so nothing was deleted and no case was recorded.',
        );
        return;
      }
      const key = `${guild.id}:PURGE:${channel.id}`;
      if (inFlightModeration.has(key)) {
        await reply(interaction, 'A purge is already running in this channel.');
        return;
      }
      inFlightModeration.add(key);
      try {
        let deletedCount = 0;
        try {
          deletedCount = (await channel.bulkDelete(amount, true)).size;
        } catch (error) {
          await reply(
            interaction,
            `Discord rejected the purge (${describeDiscordError(error)}). No case was recorded.`,
          );
          return;
        }
        const record = createCase({
          action: 'PURGE',
          moderatorId: interaction.user.id,
          targetId: null,
          reason,
          durationSeconds: null,
          evidenceReference: `${String(deletedCount)} messages in channel ${channel.id}`,
        });
        await service.saveCase(guild.id, record);
        await writeModerationLog(guild, config, record);
        await reply(
          interaction,
          `Deleted ${String(deletedCount)} recent messages. Case ${record.id}. Messages older than 14 days are skipped by Discord.`,
        );
      } finally {
        inFlightModeration.delete(key);
      }
      return;
    }
    const reason = interaction.options.getString('reason', true);
    const targetUser = command === 'unban' ? null : interaction.options.getUser('member', true);
    const targetId =
      command === 'unban' ? interaction.options.getString('user_id', true) : targetUser?.id;
    if (targetId === undefined || !/^\d{17,20}$/.test(targetId)) {
      await reply(interaction, 'Invalid Discord user ID.');
      return;
    }
    const target =
      targetUser === null ? null : await guild.members.fetch(targetId).catch(() => null);
    if (targetUser !== null && target === null) {
      await reply(interaction, 'Member is not currently available in this guild.');
      return;
    }
    const requireTarget = () => {
      if (target === null) throw new Error('Expected a guild member for this moderation command.');
      return target;
    };
    if (target !== null && !(await moderatorOutranksTarget(guild, interaction.user.id, target))) {
      await reply(interaction, 'Your highest role must strictly outrank the target member.');
      return;
    }
    if (
      target !== null &&
      !target.manageable &&
      ['timeout', 'untimeout', 'kick', 'ban', 'softban'].includes(command)
    ) {
      await reply(interaction, 'Discord role hierarchy prevents Xenon from managing this member.');
      return;
    }
    if (command === 'timeout' && !requireTarget().moderatable) {
      await reply(interaction, 'Discord role hierarchy or permissions prevent timeout.');
      return;
    }
    if (command === 'untimeout') {
      if (!requireTarget().moderatable) {
        await reply(interaction, 'Discord role hierarchy or permissions prevent timeout removal.');
        return;
      }
      const until = requireTarget().communicationDisabledUntilTimestamp;
      if (until === null || until <= Date.now()) {
        await reply(interaction, 'That member is not currently timed out.');
        return;
      }
    }
    if (command === 'ban' || command === 'unban') {
      const banned = await banState(guild, targetId);
      if (command === 'ban' && banned === 'BANNED') {
        await reply(interaction, 'That user is already banned.');
        return;
      }
      if (command === 'unban' && banned === 'NOT_BANNED') {
        await reply(interaction, 'That user is not banned.');
        return;
      }
    }
    const key = `${guild.id}:${caseAction}:${targetId}`;
    const priorCases = (await store.getGuild(guild.id)).security.cases;
    const now = Date.now();
    const recentDuplicate = priorCases.some(
      (record) =>
        record.moderatorId === interaction.user.id &&
        record.action === caseAction &&
        record.targetId === targetId &&
        now - Date.parse(record.createdAt) < DUPLICATE_WINDOW_MS,
    );
    if (inFlightModeration.has(key) || recentDuplicate) {
      await reply(
        interaction,
        'The same action on this target is already in progress or was just recorded; no duplicate was performed.',
      );
      return;
    }
    inFlightModeration.add(key);
    try {
      let durationSeconds: number | null = null;
      let softbanUnbanFailed = false;
      try {
        if (command === 'warn') {
          await requireTarget()
            .send(`You received a XenonRP moderation warning in ${guild.name}: ${reason}`)
            .catch(() => undefined);
        } else if (command === 'timeout') {
          durationSeconds = interaction.options.getInteger('minutes', true) * 60;
          await requireTarget().timeout(durationSeconds * 1_000, reason);
        } else if (command === 'untimeout') {
          await requireTarget().timeout(null, reason);
        } else if (command === 'kick') {
          await requireTarget().kick(reason);
        } else if (command === 'ban' || command === 'softban') {
          const deleteMessageSeconds =
            command === 'softban'
              ? 86_400
              : (interaction.options.getInteger('delete_days') ?? 0) * 86_400;
          await guild.members.ban(targetId, { deleteMessageSeconds, reason });
          if (command === 'softban') {
            try {
              await guild.members.unban(targetId, `Softban complete: ${reason}`);
            } catch {
              softbanUnbanFailed = true;
            }
          }
        } else {
          await guild.members.unban(targetId, reason);
        }
      } catch (error) {
        await reply(
          interaction,
          `Discord rejected the ${caseAction.toLowerCase()} (${describeDiscordError(error)}). No case was recorded.`,
        );
        return;
      }
      if (softbanUnbanFailed) {
        const record = createCase({
          action: 'BAN',
          moderatorId: interaction.user.id,
          targetId,
          reason: `Softban unban failed; member remains banned. ${reason}`.slice(0, 1_000),
          durationSeconds: null,
          evidenceReference: 'Softban ban succeeded, unban failed.',
        });
        await service.saveCase(guild.id, record);
        await writeModerationLog(guild, config, record);
        await reply(
          interaction,
          `Ban succeeded, but unban failed; <@${targetId}> remains banned. Case ${record.id}.`,
        );
        return;
      }
      const record = createCase({
        action: caseAction,
        moderatorId: interaction.user.id,
        targetId,
        reason,
        durationSeconds,
        evidenceReference: null,
      });
      await service.saveCase(guild.id, record);
      await writeModerationLog(guild, config, record);
      await reply(
        interaction,
        `Completed ${caseAction.toLowerCase()} for <@${targetId}>. Case ${record.id}.`,
      );
    } finally {
      inFlightModeration.delete(key);
    }
  });
}

export function isSecurityOrModerationCommand(name: string): boolean {
  return (
    name === 'security' ||
    [
      'warn',
      'warnings',
      'timeout',
      'untimeout',
      'kick',
      'ban',
      'unban',
      'softban',
      'purge',
      'case',
      'cases',
    ].includes(name)
  );
}

async function configure(
  guild: Guild,
  interaction: ChatInputCommandInteraction,
  store: DiscordRuntimeStore,
  service: SecurityService,
  config: SecurityConfig,
  subcommand: string,
): Promise<string> {
  if (subcommand === 'channels') {
    const alerts = interaction.options.getChannel('alerts');
    const audit = interaction.options.getChannel('audit');
    const modLogs = interaction.options.getChannel('mod_logs');
    if (alerts === null && audit === null && modLogs === null)
      return 'Select at least one channel.';
    await updateConfig(guild, store, service, (current) => ({
      ...current,
      channels: {
        alerts: alerts?.id ?? current.channels.alerts,
        audit: audit?.id ?? current.channels.audit,
        modLogs: modLogs?.id ?? current.channels.modLogs,
      },
    }));
    return 'Security channels saved. Existing channel permissions were not changed; verify that these channels are private.';
  }
  if (subcommand === 'link-policy') {
    const action = interaction.options.getString('action', true) as LinkAction;
    const domain = interaction.options
      .getString('domain')
      ?.trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '')
      .replace(/\.$/, '');
    const domainPolicy = interaction.options.getString('domain_policy');
    if (domain !== undefined && domainPolicy === null)
      return 'Choose a domain policy when supplying a domain.';
    if (domainPolicy === 'REMOVE' && domain === undefined) return 'Select the domain to remove.';
    if (
      domain !== undefined &&
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(
        domain,
      )
    )
      return 'Enter a hostname only, without a path or wildcard.';
    await updateConfig(guild, store, service, (current) => {
      const trusted = new Set(current.links.trustedDomains);
      const blocked = new Set(current.links.blockedDomains);
      if (domain !== undefined && domainPolicy === 'TRUSTED') {
        trusted.add(domain);
        blocked.delete(domain);
      }
      if (domain !== undefined && domainPolicy === 'BLOCKED') {
        blocked.add(domain);
        trusted.delete(domain);
      }
      if (domain !== undefined && domainPolicy === 'REMOVE') {
        trusted.delete(domain);
        blocked.delete(domain);
      }
      return {
        ...current,
        links: {
          ...current.links,
          action,
          trustedDomains: [...trusted],
          blockedDomains: [...blocked],
        },
      };
    });
    const removalNotice =
      domainPolicy === 'REMOVE' && domain !== undefined
        ? `Removed ${domain} from both domain lists. `
        : '';
    return `${removalNotice}Link policy set to ${action}. Local URL heuristics are not malware detection.`;
  }
  if (subcommand === 'raid-thresholds') {
    const values = {
      warning10s: interaction.options.getInteger('warning10s', true),
      raid10s: interaction.options.getInteger('raid10s', true),
      critical10s: interaction.options.getInteger('critical10s', true),
      warning30s: interaction.options.getInteger('warning30s', true),
      raid30s: interaction.options.getInteger('raid30s', true),
      critical30s: interaction.options.getInteger('critical30s', true),
    };
    if (
      values.warning10s >= values.raid10s ||
      values.raid10s >= values.critical10s ||
      values.warning30s >= values.raid30s ||
      values.raid30s >= values.critical30s
    )
      return 'Thresholds must increase: warning < raid < critical in both windows.';
    const recoveryMinutes = interaction.options.getInteger('recovery_minutes');
    const slowmodeSeconds = interaction.options.getInteger('slowmode_seconds');
    await updateConfig(guild, store, service, (current) => ({
      ...current,
      raidThresholds: { ...current.raidThresholds, ...values },
      raidRecoveryMinutes: recoveryMinutes ?? current.raidRecoveryMinutes,
      raidSlowmodeSeconds: slowmodeSeconds ?? current.raidSlowmodeSeconds,
    }));
    const saved = (await store.getGuild(guild.id)).security.config;
    return `Raid thresholds saved. Recovery after ${String(saved.raidRecoveryMinutes)} quiet minutes; raid slowmode ${saved.raidSlowmodeSeconds === 0 ? 'disabled' : `${String(saved.raidSlowmodeSeconds)}s`}.`;
  }
  if (subcommand === 'spam') {
    const limits = {
      messagesPer8Seconds: interaction.options.getInteger('messages_per_8s'),
      duplicateLimit: interaction.options.getInteger('duplicates'),
      mentionLimit: interaction.options.getInteger('mention_limit'),
      linksPer30Seconds: interaction.options.getInteger('links_per_30s'),
      emojiLimit: interaction.options.getInteger('emoji_limit'),
    };
    const operation = interaction.options.getString('exemption_action');
    const role = interaction.options.getRole('exempt_role');
    const channel = interaction.options.getChannel('exempt_channel');
    const hasLimit = Object.values(limits).some((value) => value !== null);
    const hasExemption = role !== null || channel !== null;
    if (!hasLimit && !hasExemption)
      return 'Set at least one spam limit or select an exemption target.';
    if (role !== null && role.id === guild.roles.everyone.id)
      return 'The @everyone role cannot be exempted from spam scanning.';
    if (hasExemption !== (operation !== null))
      return 'Choose an exemption action whenever you select a role or channel; an action requires a target.';
    await updateConfig(guild, store, service, (current) => {
      const exemptRoleIds = new Set(current.spam.exemptRoleIds);
      const exemptChannelIds = new Set(current.spam.exemptChannelIds);
      if (role !== null) {
        if (operation === 'ADD') exemptRoleIds.add(role.id);
        else exemptRoleIds.delete(role.id);
      }
      if (channel !== null) {
        if (operation === 'ADD') exemptChannelIds.add(channel.id);
        else exemptChannelIds.delete(channel.id);
      }
      return {
        ...current,
        spam: {
          ...current.spam,
          messagesPer8Seconds: limits.messagesPer8Seconds ?? current.spam.messagesPer8Seconds,
          duplicateLimit: limits.duplicateLimit ?? current.spam.duplicateLimit,
          mentionLimit: limits.mentionLimit ?? current.spam.mentionLimit,
          linksPer30Seconds: limits.linksPer30Seconds ?? current.spam.linksPer30Seconds,
          emojiLimit: limits.emojiLimit ?? current.spam.emojiLimit,
          exemptRoleIds: [...exemptRoleIds],
          exemptChannelIds: [...exemptChannelIds],
        },
      };
    });
    return 'Spam limits and exemptions saved.';
  }
  if (subcommand === 'keyword') {
    const operation = interaction.options.getString('operation', true);
    const value = interaction.options.getString('value', true).trim();
    const normalized = value.toLowerCase();
    if (
      operation === 'ADD' &&
      !config.prohibitedKeywords.some((keyword) => keyword.toLowerCase() === normalized) &&
      config.prohibitedKeywords.length >= 98
    ) {
      return 'Maximum 98 custom keywords reached; Discord reserves two of AutoMod’s 100 keyword slots for baseline protection.';
    }
    await updateConfig(guild, store, service, (current) => ({
      ...current,
      prohibitedKeywords:
        operation === 'ADD'
          ? [...new Set([...current.prohibitedKeywords, normalized])]
          : current.prohibitedKeywords.filter((keyword) => keyword.toLowerCase() !== normalized),
    }));
    return `Keyword ${operation === 'ADD' ? 'added' : 'removed'}. Run /security automod sync to reconcile native rules.`;
  }
  return 'Unsupported security configuration operation.';
}

async function setupSecurity(
  guild: Guild,
  store: DiscordRuntimeStore,
  service: SecurityService,
  actorId: string,
): Promise<string> {
  const existing = await store.getGuild(guild.id);
  await service.saveSnapshot(guild);
  const created: string[] = [];
  const channels = { ...existing.security.config.channels };
  const channelNames = [
    {
      key: 'alerts' as const,
      name: 'security-alerts',
      terms: ['security-alerts', 'security-alert', 'security'],
    },
    {
      key: 'audit' as const,
      name: 'security-audit',
      terms: ['security-audit', 'security-audit-log', 'audit-log'],
    },
    {
      key: 'modLogs' as const,
      name: 'mod-logs',
      terms: ['mod-logs', 'moderation-logs', 'mod-log'],
    },
  ];
  for (const entry of channelNames) {
    const configuredId = channels[entry.key];
    const configured = configuredId === null ? undefined : guild.channels.cache.get(configuredId);
    if (configured !== undefined) continue;
    const found = [...guild.channels.cache.values()].find(
      (channel) =>
        channel.type === ChannelType.GuildText && entry.terms.includes(channel.name.toLowerCase()),
    );
    let target = found;
    if (target === undefined) {
      try {
        target = await guild.channels.create({
          name: entry.name,
          type: ChannelType.GuildText,
          reason: 'Xenon security idempotent setup',
          permissionOverwrites: [
            { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
            {
              id: guild.client.user.id,
              allow: [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ReadMessageHistory],
            },
            { id: guild.ownerId, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] },
            ...(actorId === guild.ownerId
              ? []
              : [{ id: actorId, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] }]),
            ...Object.entries(existing.security.config.trustedActors)
              .filter(([, trust]) => trust !== 'UNTRUSTED')
              .map(([userId]) => ({
                id: userId,
                allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory],
              })),
          ],
        });
        created.push(`#${entry.name}`);
      } catch {
        continue;
      }
    }
    channels[entry.key] = target.id;
  }
  let quarantineRoleId: string | null = null;
  let unsafeQuarantineRole = false;
  const configuredRole =
    existing.security.config.quarantineRoleId === null
      ? undefined
      : guild.roles.cache.get(existing.security.config.quarantineRoleId);
  const markerRole =
    configuredRole ??
    guild.roles.cache.find((role) => role.name.toLowerCase() === 'xenon quarantine');
  if (markerRole !== undefined) {
    if (!markerRole.managed && markerRole.permissions.bitfield === 0n)
      quarantineRoleId = markerRole.id;
    else unsafeQuarantineRole = true;
  } else {
    try {
      const role = await guild.roles.create({
        name: 'Xenon Quarantine',
        permissions: [],
        reason: 'Xenon security idempotent setup',
      });
      quarantineRoleId = role.id;
      created.push('@Xenon Quarantine');
    } catch {
      quarantineRoleId = null;
    }
  }
  const protectedIds = new Set(Object.values(channels).filter((id): id is string => id !== null));
  const publicChannels = [...guild.channels.cache.values()].filter(
    (channel): channel is NonThreadGuildBasedChannel =>
      [
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
        ChannelType.GuildForum,
        ChannelType.GuildMedia,
      ].includes(channel.type) &&
      !protectedIds.has(channel.id) &&
      !PUBLIC_EXCLUSION.test(channel.name) &&
      !(channel.parent?.name !== undefined && PUBLIC_EXCLUSION.test(channel.parent.name)),
  );
  await store.updateGuild(guild.id, (current) => ({
    ...current,
    security: {
      ...current.security,
      config: {
        ...current.security.config,
        channels,
        quarantineRoleId,
        lockdownChannelIds: publicChannels.map((channel) => channel.id),
      },
    },
  }));
  const automod = await service.syncAutoMod(guild).catch((error: unknown) => ({
    created: [],
    updated: [],
    conflicts: [],
    unavailable: error instanceof Error ? error.message : 'AutoMod API unavailable',
  }));
  return `Security setup complete. Created: ${created.join(', ') || 'none'}.\nChannels: alerts ${channels.alerts === null ? 'MISSING' : `<#${channels.alerts}>`}, audit ${channels.audit === null ? 'MISSING' : `<#${channels.audit}>`}, mod logs ${channels.modLogs === null ? 'MISSING' : `<#${channels.modLogs}>`}.\nQuarantine role (marker only; member-specific channel overwrites enforce restrictions): ${quarantineRoleId === null ? 'MISSING' : `<@&${quarantineRoleId}>`}.${unsafeQuarantineRole ? '\nExisting Xenon Quarantine role has permissions or is managed — remove them or delete it; marker disabled. The role was not modified.' : ''}\nAutoMod: created ${automod.created.join(', ') || 'none'}, conflicts ${automod.conflicts.join('; ') || 'none'}${automod.unavailable === null ? '' : `; unavailable: ${automod.unavailable}`}\nReview /security scan and verify new log-channel privacy before relying on automation.`;
}

const MODE_SUMMARY: Record<EnforcementMode, string> = {
  OBSERVE:
    'detect and record incidents only; no automatic Discord changes, member DMs, or channel posts',
  ALERT:
    'detect, record, and post incidents to the security channels; no automatic punishment, DMs, or server changes',
  ENFORCE: 'automatic responses are active (subject to module settings and safety checks)',
};

interface ActiveRestrictions {
  readonly lockdown: boolean;
  readonly quarantines: number;
  readonly raidSlowmodeChannels: number;
}

function activeRestrictionsOf(state: SecurityGuildState): ActiveRestrictions {
  return {
    lockdown: state.lockdown !== null,
    quarantines: state.quarantines.length,
    raidSlowmodeChannels: state.raidResponse?.slowmode.length ?? 0,
  };
}

function describeRestrictions(restrictions: ActiveRestrictions): string {
  return `Lockdown: ${restrictions.lockdown ? 'ACTIVE' : 'not active'}; quarantined members: ${String(restrictions.quarantines)}; raid slowmode channels: ${String(restrictions.raidSlowmodeChannels)}.`;
}

function releaseGuidance(restrictions: ActiveRestrictions): string[] {
  return [
    ...(restrictions.lockdown ? ['/security unlock — restore the lockdown overwrites'] : []),
    ...(restrictions.quarantines > 0
      ? ['/security unquarantine member:<member> reason:<text> — release each quarantined member']
      : []),
    ...(restrictions.raidSlowmodeChannels > 0
      ? ['/security raid-mode off — release raid slowmode']
      : []),
  ];
}

async function handleModeCommand(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
  state: SecurityGuildState,
  service: SecurityService,
): Promise<void> {
  const config = state.config;
  const subcommand = interaction.options.getSubcommand(true);
  if (subcommand === 'status') {
    await reply(
      interaction,
      [
        `Enforcement mode: ${config.enforcementMode}`,
        `OBSERVE — ${MODE_SUMMARY.OBSERVE}.`,
        `ALERT — ${MODE_SUMMARY.ALERT}.`,
        `ENFORCE — ${MODE_SUMMARY.ENFORCE}.`,
        'Manual staff commands work in every mode.',
        `Protections ENFORCE ${config.enforcementMode === 'ENFORCE' ? 'has active' : 'would activate'}:`,
        ...enforcedProtections(config).map((line) => `• ${line}`),
        `Active restrictions — ${describeRestrictions(activeRestrictionsOf(state))}`,
      ].join('\n'),
    );
    return;
  }
  const requested = interaction.options.getString('mode', true).toUpperCase();
  if (requested !== 'OBSERVE' && requested !== 'ALERT' && requested !== 'ENFORCE') {
    await reply(interaction, 'Unknown mode. Choose observe, alert, or enforce.');
    return;
  }
  const mode: EnforcementMode = requested;
  if (mode === 'ENFORCE' && interaction.options.getBoolean('confirm') !== true) {
    await reply(
      interaction,
      [
        'Enforcement mode was not changed. ENFORCE would activate these automatic responses:',
        ...enforcedProtections(config).map((line) => `• ${line}`),
        'To confirm, run: /security mode set mode:enforce confirm:true',
      ].join('\n'),
    );
    return;
  }
  const change = await service.setEnforcementMode(guild, mode, interaction.user.id);
  const guidance =
    change.previous === 'ENFORCE' && change.current !== 'ENFORCE'
      ? releaseGuidance(change.activeRestrictions)
      : [];
  await reply(
    interaction,
    [
      `Enforcement mode: ${change.previous} → ${change.current}.`,
      MODE_SUMMARY[change.current],
      ...(guidance.length > 0
        ? [
            'Existing restrictions were not released automatically. Release them with:',
            ...guidance.map((line) => `• ${line}`),
          ]
        : []),
    ].join('\n'),
  );
}

export type PostureLabel = 'LOCKDOWN' | 'DISABLED' | 'AT RISK' | 'DEGRADED' | 'PROTECTED';

export interface PostureInput {
  readonly lockdownActive: boolean;
  readonly enabled: boolean;
  readonly findings: readonly { readonly severity: SecuritySeverity }[];
  readonly incidents: readonly {
    readonly severity: SecuritySeverity;
    readonly status: IncidentStatus;
  }[];
  readonly raidLevel: 'NORMAL' | 'WARNING' | 'RAID' | 'CRITICAL' | null;
  readonly degraded: boolean;
  /** Automatic protection is inactive unless ENFORCE. */
  readonly enforcementMode: EnforcementMode;
}

/** Precedence: LOCKDOWN > DISABLED > AT RISK > DEGRADED > PROTECTED. */
export function computePostureLabel(input: PostureInput): PostureLabel {
  if (input.lockdownActive) return 'LOCKDOWN';
  if (!input.enabled) return 'DISABLED';
  if (
    input.findings.some((finding) => finding.severity === 'CRITICAL') ||
    input.incidents.some(
      (incident) =>
        incident.status === 'OPEN' &&
        (incident.severity === 'HIGH' || incident.severity === 'CRITICAL'),
    ) ||
    input.raidLevel === 'RAID' ||
    input.raidLevel === 'CRITICAL'
  )
    return 'AT RISK';
  if (input.enforcementMode !== 'ENFORCE') return 'DEGRADED';
  return input.degraded ? 'DEGRADED' : 'PROTECTED';
}

async function securityStatus(
  guild: Guild,
  state: {
    readonly config: SecurityConfig;
    readonly incidents: readonly SecurityIncident[];
    readonly snapshots: readonly { readonly createdAt: string }[];
    readonly lockdown: unknown;
  },
  service: SecurityService,
): Promise<EmbedBuilder> {
  const config = state.config;
  const me = guild.members.me;
  const missingChannels = Object.values(config.channels).some(
    (id) => id === null || guild.channels.cache.get(id) === undefined,
  );
  const automodRules = config.modules.autoMod
    ? await guild.autoModerationRules.fetch().catch(() => null)
    : null;
  const ownedRules =
    automodRules === null
      ? []
      : config.ownedAutoModRuleIds
          .map((id) => automodRules.get(id))
          .filter((rule) => rule !== undefined);
  const automodDegraded =
    config.modules.autoMod &&
    (automodRules === null || ownedRules.length < 3 || ownedRules.some((rule) => !rule.enabled));
  const needsMessageContent = config.modules.spam || config.modules.linkGuard;
  const contentAvailable = service.isMessageContentAvailable();
  const findings = await service.scanPermissions(guild);
  const raid = await service.raidStatus(guild.id).catch(() => null);
  let nativeChecks: readonly NativeSafetyCheck[];
  try {
    nativeChecks = service.nativeSafety(guild);
  } catch {
    nativeChecks = [];
  }
  const capabilityGaps = findings.filter(
    (finding) =>
      finding.code.startsWith('BOT_MISSING_') || finding.code === 'BOT_ADMINISTRATOR_GRANTED',
  );
  const intents = guild.client.options.intents;
  const intentChecks = [
    ['Guilds', GatewayIntentBits.Guilds],
    ['GuildMembers', GatewayIntentBits.GuildMembers],
    ['GuildModeration', GatewayIntentBits.GuildModeration],
    ['GuildMessages', GatewayIntentBits.GuildMessages],
    ['MessageContent', GatewayIntentBits.MessageContent],
  ] as const;
  const missingIntents = intentChecks.filter(([, bit]) => !intents.has(bit)).map(([name]) => name);
  const botTop = me?.roles.highest;
  const hierarchyRisk =
    botTop === undefined
      ? null
      : [...guild.roles.cache.values()].filter(
          (role) =>
            role.id !== guild.roles.everyone.id &&
            role.id !== botTop.id &&
            role.position >= botTop.position &&
            DANGEROUS_BITS.some((flag) => role.permissions.has(flag)),
        ).length;
  const degraded =
    config.enabled &&
    (missingChannels ||
      me === null ||
      capabilityGaps.length > 0 ||
      (needsMessageContent && !contentAvailable) ||
      automodDegraded);
  const level = computePostureLabel({
    lockdownActive: state.lockdown !== null,
    enabled: config.enabled,
    findings,
    incidents: state.incidents,
    raidLevel: raid?.level ?? null,
    degraded,
    enforcementMode: config.enforcementMode,
  });
  const contentStatus = !needsMessageContent
    ? 'NOT REQUIRED'
    : contentAvailable
      ? 'AVAILABLE'
      : 'UNAVAILABLE — custom spam/link scanning inactive';
  const automodStatus = !config.modules.autoMod
    ? 'OFF'
    : automodRules === null
      ? 'UNAVAILABLE'
      : `${String(ownedRules.filter((rule) => rule.enabled).length)}/3 owned rules enabled`;
  const gapSummary =
    capabilityGaps.length === 0
      ? 'No bot permission findings'
      : capabilityGaps
          .slice(0, 5)
          .map((finding) => finding.code)
          .join(', ');
  const auditLogAvailable = me?.permissions.has(P.ViewAuditLog) === true;
  const manualActions = [
    ...nativeChecks
      .filter((check) => check.status === 'MANUAL ACTION REQUIRED')
      .map((check) => `${check.name}: ${check.detail}`),
    ...(auditLogAvailable ? [] : ['Grant View Audit Log to Xenon']),
    ...(hierarchyRisk !== null && hierarchyRisk > 0
      ? [`Move the Xenon role above ${String(hierarchyRisk)} dangerous role(s)`]
      : []),
    ...(missingIntents.length > 0 ? [`Enable gateway intents: ${missingIntents.join(', ')}`] : []),
    ...(needsMessageContent && !contentAvailable ? ['Enable the Message Content intent'] : []),
  ];
  return new EmbedBuilder()
    .setColor(
      level === 'PROTECTED'
        ? 0x2f855a
        : level === 'LOCKDOWN' || level === 'AT RISK'
          ? 0x991b1b
          : 0xd97706,
    )
    .setTitle(`Xenon Security · ${level}`)
    .addFields(
      {
        name: 'Enforcement mode',
        value: clip(
          `${config.enforcementMode} — ${MODE_SUMMARY[config.enforcementMode]}\nChange with /security mode set.`,
        ),
        inline: false,
      },
      { name: 'Controller', value: config.enabled ? 'ENABLED' : 'DISABLED', inline: true },
      {
        name: 'Raid detection',
        value: `${config.modules.raid ? 'ON' : 'OFF'} · ${config.raidMode}`,
        inline: true,
      },
      {
        name: 'Live raid state',
        value:
          raid === null
            ? 'UNAVAILABLE'
            : clip(
                `${raid.level} · ${String(raid.joins10s)}/10s · ${String(raid.joins30s)}/30s · slowmode ${String(raid.slowmodeChannels)} ch${raid.activeSince === null ? '' : ` · since ${raid.activeSince}`}${raid.recoveryAt === null ? '' : ` · recovery ${raid.recoveryAt}`}`,
              ),
        inline: true,
      },
      { name: 'Anti-nuke', value: config.modules.antiNuke ? 'ON' : 'OFF', inline: true },
      { name: 'AutoMod', value: automodStatus, inline: true },
      {
        name: 'Spam guard',
        value: clip(
          `${config.modules.spam ? 'ON' : 'OFF'} · ${config.spam.messagesPer8Seconds}/8s · ${config.spam.duplicateLimit} duplicates · ${config.spam.mentionLimit} mentions · ${config.spam.linksPer30Seconds}/30s · ${config.spam.emojiLimit} emoji · exemptions ${config.spam.exemptRoleIds.length} roles/${config.spam.exemptChannelIds.length} channels · Content ${contentStatus}`,
        ),
        inline: false,
      },
      {
        name: 'Link guard',
        value: config.modules.linkGuard
          ? clip(
              `${config.links.action} · local heuristics only · Message Content ${contentStatus}`,
            )
          : 'OFF',
        inline: false,
      },
      {
        name: 'Permission guard',
        value: config.modules.permissionGuard ? 'ON' : 'OFF',
        inline: true,
      },
      {
        name: 'Member protection',
        value:
          config.quarantineRoleId === null
            ? 'Per-member restrictions · marker role unavailable'
            : `Per-member restrictions · marker <@&${config.quarantineRoleId}>`,
        inline: true,
      },
      { name: 'Lockdown', value: state.lockdown === null ? 'INACTIVE' : 'ACTIVE', inline: true },
      {
        name: 'Open incidents',
        value: String(state.incidents.filter((incident) => incident.status === 'OPEN').length),
        inline: true,
      },
      {
        name: 'Contained incidents',
        value: String(state.incidents.filter((incident) => incident.status === 'CONTAINED').length),
        inline: true,
      },
      { name: 'Last snapshot', value: state.snapshots.at(-1)?.createdAt ?? 'None', inline: false },
      { name: 'Bot permission gaps', value: clip(gapSummary), inline: false },
      {
        name: 'Audit Log access',
        value: auditLogAvailable ? 'AVAILABLE' : 'MISSING — MANUAL ACTION REQUIRED',
        inline: true,
      },
      {
        name: 'Bot hierarchy health',
        value:
          hierarchyRisk === null
            ? 'UNKNOWN — bot member unavailable'
            : hierarchyRisk === 0
              ? 'OK — no dangerous roles at or above the bot'
              : `${String(hierarchyRisk)} dangerous role(s) at or above the bot`,
        inline: true,
      },
      {
        name: 'Gateway intents',
        value: clip(
          `${intentChecks.map(([name, bit]) => `${name} ${intents.has(bit) ? '✓' : '✗'}`).join(' · ')} · Message Content ${contentAvailable ? 'AVAILABLE' : 'UNAVAILABLE'}`,
        ),
        inline: false,
      },
      {
        name: 'Native Discord safety',
        value:
          nativeChecks.length === 0
            ? 'Unavailable'
            : clip(nativeChecks.map((check) => `${check.name}: ${check.status}`).join('\n')),
        inline: false,
      },
      {
        name: 'Manual action required',
        value:
          manualActions.length === 0
            ? 'None'
            : clip(manualActions.map((item) => `• ${item}`).join('\n')),
        inline: false,
      },
    );
}

async function updateConfig(
  guild: Guild,
  store: DiscordRuntimeStore,
  service: SecurityService,
  update: (config: SecurityConfig) => SecurityConfig,
): Promise<void> {
  await service.saveSnapshot(guild);
  await store.updateGuild(guild.id, (current) => ({
    ...current,
    security: { ...current.security, config: update(current.security.config) },
  }));
}

async function moderatorOutranksTarget(
  guild: Guild,
  actorId: string,
  target: GuildMember,
): Promise<boolean> {
  if (actorId === guild.ownerId) return true;
  if (target.id === guild.ownerId) return false;
  const [actor, freshTarget] = await Promise.all([
    guild.members.fetch({ user: actorId, force: true }).catch(() => null),
    guild.members.fetch({ user: target.id, force: true }).catch(() => null),
  ]);
  return (
    actor !== null &&
    freshTarget !== null &&
    actor.roles.highest.comparePositionTo(freshTarget.roles.highest) > 0
  );
}

function authorize(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
  config: SecurityConfig,
  permission: bigint,
  minimum: TrustLevel,
): boolean {
  const trust = trustForActor(config, interaction.user.id, guild.ownerId);
  return permissionCheck(
    interaction.memberPermissions,
    permission,
    trust,
    interaction.user.id === guild.ownerId,
    minimum,
  );
}

async function reply(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  if (interaction.deferred || interaction.replied)
    await interaction.editReply({ content: content.slice(0, 1_900), embeds: [] });
  else await interaction.reply({ content: content.slice(0, 1_900), flags: MessageFlags.Ephemeral });
}

const SEVERITY_ORDER: readonly SecuritySeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
const DUPLICATE_WINDOW_MS = 15_000;
const inFlightModeration = new Set<string>();
const MODERATION_ACTIONS: Readonly<Record<string, CaseAction | undefined>> = {
  warn: 'WARN',
  timeout: 'TIMEOUT',
  untimeout: 'UNTIMEOUT',
  kick: 'KICK',
  ban: 'BAN',
  unban: 'UNBAN',
  softban: 'SOFTBAN',
  purge: 'PURGE',
};
const BOT_REQUIREMENTS: Readonly<
  Record<string, { readonly flag: bigint; readonly name: string } | undefined>
> = {
  timeout: { flag: P.ModerateMembers, name: 'Moderate Members' },
  untimeout: { flag: P.ModerateMembers, name: 'Moderate Members' },
  kick: { flag: P.KickMembers, name: 'Kick Members' },
  ban: { flag: P.BanMembers, name: 'Ban Members' },
  unban: { flag: P.BanMembers, name: 'Ban Members' },
  softban: { flag: P.BanMembers, name: 'Ban Members' },
  purge: { flag: P.ManageMessages, name: 'Manage Messages' },
};

function clip(value: string, max = 1_024): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function fit(value: string): string {
  return value.length > 1_900 ? `${value.slice(0, 1_860)}\n…(truncated)` : value;
}

async function banState(
  guild: Guild,
  userId: string,
): Promise<'BANNED' | 'NOT_BANNED' | 'UNKNOWN'> {
  try {
    await guild.bans.fetch(userId);
    return 'BANNED';
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 10_026
      ? 'NOT_BANNED'
      : 'UNKNOWN';
  }
}

function formatIncident(incident: SecurityIncident): string {
  return [
    `Incident ${incident.id} · ${incident.severity} · ${incident.status}`,
    `Title: ${incident.title}`,
    `Source/rule: ${incident.source} / ${incident.rule}`,
    `Created: ${incident.createdAt}`,
    `Actor: ${incident.actorId === null ? 'unknown' : `<@${incident.actorId}>`} (${incident.automatic ? 'automatic' : 'manual'}; audit ${incident.auditCorrelation})`,
    `Target: ${incident.targetId ?? 'none'}`,
    `Evidence:\n${incident.evidence.map((item) => `• ${item}`).join('\n') || 'none'}`,
    `Actions:\n${incident.actionTaken.map((item) => `• ${item}`).join('\n') || 'none'}`,
    ...(incident.resolvedAt === undefined
      ? []
      : [
          `Resolved: ${incident.resolvedAt} by ${incident.resolvedBy === undefined ? 'unknown' : `<@${incident.resolvedBy}>`} — ${incident.resolution ?? 'no note'}`,
        ]),
  ].join('\n');
}

function renderScan(findings: readonly PermissionFinding[]): {
  readonly content: string;
  readonly embeds: EmbedBuilder[];
} {
  const sorted = [...findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
  const counts = SEVERITY_ORDER.map(
    (severity) =>
      `${severity} ${String(sorted.filter((item) => item.severity === severity).length)}`,
  ).join(' · ');
  const chunks: string[] = [];
  let current = '';
  let shown = 0;
  for (const finding of sorted) {
    const line = clip(
      `**${finding.severity} · ${finding.code}** — ${finding.subject}: ${finding.detail}\n↳ Fix: ${finding.remediation}`,
      700,
    );
    if (current.length + line.length + 2 > 3_500) {
      chunks.push(current);
      current = '';
    }
    if (chunks.length === 3) break;
    current = current === '' ? line : `${current}\n\n${line}`;
    shown += 1;
  }
  if (chunks.length < 3 && current !== '') chunks.push(current);
  const hidden = sorted.length - shown;
  return {
    content: `Scan findings: ${counts}${hidden > 0 ? ` · ${String(hidden)} more not shown` : ''}`,
    embeds: chunks.map((chunk, position) =>
      new EmbedBuilder()
        .setColor(0x475569)
        .setTitle(`Scan findings ${String(position + 1)}/${String(chunks.length)}`)
        .setDescription(chunk),
    ),
  };
}

function formatCaseSummary(record: {
  readonly id: string;
  readonly action: CaseAction;
  readonly targetId: string | null;
  readonly createdAt: string;
  readonly reason: string;
}): string {
  return `${record.id} · ${record.action} · ${record.targetId === null ? 'server action' : `<@${record.targetId}>`} · ${record.createdAt} · ${record.reason}`;
}

function formatCaseDetails(record: {
  readonly id: string;
  readonly action: CaseAction;
  readonly targetId: string | null;
  readonly moderatorId: string;
  readonly reason: string;
  readonly createdAt: string;
  readonly durationSeconds: number | null;
  readonly evidenceReference: string | null;
}): string {
  return [
    `Case ${record.id}`,
    `Action: ${record.action}`,
    `Moderator: <@${record.moderatorId}>`,
    `Target: ${record.targetId === null ? 'server action' : `<@${record.targetId}>`}`,
    `Reason: ${record.reason}`,
    `Timestamp: ${record.createdAt}`,
    `Duration: ${record.durationSeconds === null ? 'none' : `${String(record.durationSeconds)} seconds`}`,
    `Evidence reference: ${record.evidenceReference ?? 'none'}`,
  ].join('\n');
}

async function writeModerationLog(
  guild: Guild,
  config: SecurityConfig,
  record: {
    readonly id: string;
    readonly action: CaseAction;
    readonly moderatorId: string;
    readonly targetId: string | null;
    readonly reason: string;
    readonly durationSeconds: number | null;
  },
): Promise<void> {
  const channel =
    config.channels.modLogs === null ? null : guild.channels.cache.get(config.channels.modLogs);
  if (channel === null || channel === undefined || !('send' in channel)) return;
  const embed = new EmbedBuilder()
    .setColor(0x475569)
    .setTitle(`Moderation case · ${record.id}`)
    .setDescription(
      `Action: ${record.action}\nModerator: <@${record.moderatorId}>\nTarget: ${record.targetId === null ? 'Server action' : `<@${record.targetId}>`}\nDuration: ${record.durationSeconds === null ? 'none' : `${String(record.durationSeconds)} seconds`}\nReason: ${record.reason}`.slice(
        0,
        4_000,
      ),
    )
    .setTimestamp();
  await channel.send({ embeds: [embed] }).catch(() => undefined);
}
