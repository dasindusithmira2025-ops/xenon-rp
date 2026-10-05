import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type ChatInputCommandInteraction,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

import { toSafeMessage, type PermissionKey } from '@xenon/core';
import { prisma, type DiscordProvisionRun } from '@xenon/database';
import { type XenonId, xenonEmbed, xenonIds } from '@xenon/discord';
import {
  createRun,
  panelHash,
  planItems,
  planProfile,
  PROVISION_PHRASE,
  type RunMode,
  saveBlueprintFeatures,
  blueprintFeatures,
} from '@xenon/discord/provisioning';
import { recordAudit } from '@xenon/domain';
import type { Actor } from '@xenon/permissions';

import { logger } from '../runtime';

import { actorFromDiscord } from './actor';
import { loadProvisioningContext } from './provisioning/context';
import { buildRunEmbed, controlUrl } from './provisioning/report';
import { executeProvisionRun } from './provisioning/runner';
import { adoptionReply, adoptGuildResources } from './setup-adopt';

/**
 * `/xenon setup …` and `/xenon automod …`.
 *
 * Every subcommand goes through the same engine and the same run table as the
 * Control Center and the CLI. Nothing mutates from a single click: apply and
 * repair always generate a fresh plan, show it, and only then offer a button
 * that opens a modal asking for the typed phrase.
 *
 * Authority is Xenon RBAC (`system.discord.bootstrap`) or ownership of the
 * Discord server itself. A Discord Administrator role alone is not enough.
 */

export const xenonCommand = new SlashCommandBuilder()
  .setName('xenon')
  .setDescription('Xenon server provisioning')
  // Hidden from regular members; the real check is Xenon RBAC below.
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommandGroup((group) =>
    group
      .setName('setup')
      .setDescription('Provision and maintain the Xenon Discord server')
      .addSubcommand((sub) =>
        sub
          .setName('adopt')
          .setDescription('Bind exact existing resources without changing Discord'),
      )
      .addSubcommand((sub) =>
        sub.setName('plan').setDescription('Show exactly what would change. Changes nothing.'),
      )
      .addSubcommand((sub) =>
        sub.setName('apply').setDescription('Plan, review, then apply Xenon-managed changes'),
      )
      .addSubcommand((sub) => sub.setName('status').setDescription('Show health and drift'))
      .addSubcommand((sub) =>
        sub
          .setName('repair')
          .setDescription('Restore Xenon-managed resources that drifted')
          .addBooleanOption((option) =>
            option
              .setName('include-soft')
              .setDescription('Also restore names, topics and order')
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('validate').setDescription('Run the critical permission and hierarchy tests'),
      )
      .addSubcommand((sub) =>
        sub.setName('permissions').setDescription('Who can see the restricted areas'),
      )
      .addSubcommand((sub) =>
        sub.setName('assets').setDescription('Emoji and sticker upload state and capacity'),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('panel')
      .setDescription('Manage Xenon text-first panels')
      .addSubcommand((sub) =>
        sub.setName('setup').setDescription('Plan the creation of missing Xenon panels'),
      )
      .addSubcommand((sub) =>
        sub.setName('refresh').setDescription('Refresh existing panel messages in place'),
      )
      .addSubcommand((sub) =>
        sub.setName('status').setDescription('Check managed panel messages and health'),
      )
      .addSubcommand((sub) =>
        sub.setName('repair').setDescription('Plan repair of missing or drifted panels'),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('automod')
      .setDescription('Conservative AutoMod safety rules')
      .addSubcommand((sub) => sub.setName('status').setDescription('Show the Xenon AutoMod rules'))
      .addSubcommand((sub) =>
        sub.setName('enable').setDescription('Include AutoMod in the next plan'),
      )
      .addSubcommand((sub) =>
        sub.setName('disable').setDescription('Turn the Xenon AutoMod rules off'),
      ),
  )
  .toJSON();

const BOOTSTRAP: PermissionKey = 'system.discord.bootstrap';

type SetupInteraction = ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction;

/**
 * Resolve the actor, lending the bootstrap capability to the guild owner: the
 * owner of the Discord server is authoritative over its structure even before
 * Xenon RBAC has been set up for them.
 */
async function provisioningActor(interaction: SetupInteraction): Promise<Actor | null> {
  const actor = await actorFromDiscord(interaction.user.id);
  if (actor.permissions.has(BOOTSTRAP)) return actor;
  if (interaction.guild?.ownerId === interaction.user.id) {
    return {
      ...actor,
      label: actor.userId === null ? `Discord owner ${interaction.user.username}` : actor.label,
      permissions: new Set([...actor.permissions, BOOTSTRAP]),
    };
  }
  return null;
}

function reviewButtons(
  run: DiscordProvisionRun,
  mode: 'apply' | 'repair',
  panelOnly = false,
): ActionRowBuilder<ButtonBuilder>[] {
  const items = planItems(run.plannedChanges).filter(
    (item) => !panelOnly || item.resourceType === 'PANEL',
  );
  const count =
    mode === 'apply'
      ? items.filter(
          (item) =>
            ['CREATE', 'UPDATE', 'MOVE', 'PERMISSION_CHANGE'].includes(item.kind) &&
            item.blockedBy === undefined,
        ).length
      : items.filter((item) => item.kind === 'DRIFT').length;
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (run.status === 'SUCCEEDED' && count > 0) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(xenonIds.setupApprove(mode, run.id))
        .setLabel(
          mode === 'apply' ? `Apply ${String(count)} changes` : `Repair ${String(count)} drifted`,
        )
        .setStyle(mode === 'apply' ? ButtonStyle.Success : ButtonStyle.Primary),
    );
  }
  row.addComponents(
    new ButtonBuilder()
      .setLabel('Review in Control Center')
      .setStyle(ButtonStyle.Link)
      .setURL(controlUrl(run.id)),
  );
  return [row];
}

async function runNow(
  interaction: SetupInteraction,
  actor: Actor,
  mode: RunMode,
  extra: Partial<Parameters<typeof createRun>[2]> = {},
  executeOptions: { readonly onlyKeys?: ReadonlySet<string> } = {},
) {
  const guildId = interaction.guildId;
  if (guildId === null) throw new Error('Run this inside the Xenon server.');
  const run = await createRun(prisma, actor, { guildId, mode, ...extra });
  return executeProvisionRun(interaction.client, run.id, executeOptions);
}

export async function handleXenonCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const group = interaction.options.getSubcommandGroup(true);
  const sub = interaction.options.getSubcommand(true);
  const adopting = group === 'setup' && sub === 'adopt';
  if (adopting) await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const actor = await provisioningActor(interaction);
  if (actor === null) {
    const response = {
      content:
        'Provisioning needs the Xenon `system.discord.bootstrap` permission or ownership of this server.',
      flags: MessageFlags.Ephemeral,
    } as const;
    if (adopting) await interaction.editReply(response.content);
    else await interaction.reply(response);
    return;
  }

  if (!adopting) await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    if (adopting) {
      if (interaction.guild === null) {
        await interaction.editReply('Run adoption inside the Xenon Discord server.');
        return;
      }
      const { plan, state } = await adoptGuildResources(interaction.guild, actor);
      await interaction.editReply(adoptionReply(plan, state));
      return;
    }
    if (group === 'panel') {
      await handlePanelCommand(interaction, actor, sub);
      return;
    }
    if (group === 'automod') {
      await handleAutomod(interaction, actor, sub);
      return;
    }

    switch (sub) {
      case 'plan':
      case 'apply': {
        const run = await runNow(interaction, actor, 'PLAN');
        await interaction.editReply({
          embeds: [buildRunEmbed(run)],
          components: reviewButtons(run, 'apply'),
        });
        return;
      }
      case 'repair': {
        const run = await runNow(interaction, actor, 'PLAN');
        await prisma.discordProvisionRun.update({
          where: { id: run.id },
          data: {
            options: { includeSoft: interaction.options.getBoolean('include-soft') === true },
          },
        });
        await interaction.editReply({
          embeds: [buildRunEmbed(run)],
          components: reviewButtons(run, 'repair'),
        });
        return;
      }
      case 'status':
      case 'assets': {
        const run = await runNow(interaction, actor, 'STATUS');
        const embed = buildRunEmbed(run);
        if (sub === 'assets') {
          const assets = planItems(run.plannedChanges).filter((item) => item.phase === 'ASSETS');
          const tally = (kind: string) => assets.filter((item) => item.kind === kind).length;
          embed.setTitle('SERVER ASSETS').setFields({
            name: 'Emoji and stickers',
            value:
              assets.length === 0
                ? 'No enabled assets in the manifest.'
                : `${String(tally('UNCHANGED'))} uploaded · ${String(tally('CREATE'))} pending · ${String(tally('DRIFT'))} removed · ${String(tally('CAPACITY_BLOCKED'))} over capacity · ${String(tally('CONFLICT'))} conflicts`,
          });
        }
        await interaction.editReply({
          embeds: [embed],
          components: reviewButtons(run, 'apply').slice(0, 1),
        });
        return;
      }
      case 'validate':
      case 'permissions': {
        const run = await runNow(interaction, actor, 'VALIDATE');
        const embed = buildRunEmbed(run);
        if (sub === 'permissions') {
          const planned = run.plannedChanges as {
            liveAudit?: {
              matrix?: {
                key: string;
                label: string;
                access: { persona: string; view: boolean }[];
              }[];
            };
          } | null;
          const restricted = (planned?.liveAudit?.matrix ?? [])
            .filter((row) => /^category\.(staff|ops|dept|org)/.test(row.key))
            .slice(0, 8);
          embed.setFields(
            restricted.length === 0
              ? [{ name: 'Restricted areas', value: 'Nothing provisioned yet.' }]
              : restricted.map((row) => ({
                  name: row.label,
                  value:
                    row.access
                      .filter((entry) => entry.view)
                      .map((entry) => entry.persona)
                      .join(', ')
                      .slice(0, 1000) || 'Nobody',
                })),
          );
        }
        await interaction.editReply({ embeds: [embed] });
        return;
      }
      default:
        await interaction.editReply('That subcommand is not available.');
    }
  } catch (error) {
    logger.warn({ err: error, sub }, 'Setup command failed');
    await interaction.editReply(toSafeMessage(error));
  }
}

async function handlePanelCommand(
  interaction: ChatInputCommandInteraction,
  actor: Actor,
  sub: string,
): Promise<void> {
  const guildId = interaction.guildId;
  if (guildId === null) {
    await interaction.editReply('Run panel commands inside the Xenon server.');
    return;
  }

  if (sub === 'setup' || sub === 'repair') {
    const run = await runNow(interaction, actor, 'PLAN');
    await prisma.discordProvisionRun.update({
      where: { id: run.id },
      data: { options: { scope: 'panels' } },
    });
    const panelChanges = planItems(run.plannedChanges).filter(
      (item) => item.resourceType === 'PANEL' && ['CREATE', 'UPDATE', 'DRIFT'].includes(item.kind),
    );
    if (panelChanges.length === 0) {
      await interaction.editReply({
        embeds: [
          xenonEmbed('success')
            .setTitle('XENON PANELS')
            .setDescription(
              sub === 'setup'
                ? 'All configured Xenon panels are up to date.'
                : 'No missing or drifted panels need repair.',
            ),
        ],
      });
      return;
    }
    const mode = sub === 'setup' ? 'apply' : 'repair';
    await interaction.editReply({
      embeds: [
        buildRunEmbed(run)
          .setTitle(sub === 'setup' ? 'XENON PANEL SETUP' : 'XENON PANEL REPAIR')
          .setDescription(
            `${String(panelChanges.length)} panel change${panelChanges.length === 1 ? '' : 's'} are ready for review. Confirming updates only Xenon panel messages.`,
          ),
      ],
      components: reviewButtons(run, mode, true),
    });
    return;
  }

  if (sub === 'refresh') {
    const guild = await interaction.client.guilds.fetch(guildId);
    const context = await loadProvisioningContext(guild);
    const panels = await prisma.discordManagedResource.findMany({
      where: { guildId, resourceType: 'PANEL', managed: true, discordResourceId: { not: null } },
    });
    let updated = 0;
    const missing: string[] = [];
    for (const entry of panels) {
      const desired = context.state.panels.find((panel) => panel.key === entry.logicalKey);
      if (desired === undefined || entry.discordResourceId === null || entry.channelId === null) {
        missing.push(entry.logicalKey);
        continue;
      }
      const channel = await interaction.client.channels.fetch(entry.channelId).catch(() => null);
      if (channel === null || !channel.isTextBased() || !('messages' in channel)) {
        missing.push(entry.logicalKey);
        continue;
      }
      const message = await channel.messages.fetch(entry.discordResourceId).catch(() => null);
      if (message === null) {
        missing.push(entry.logicalKey);
        continue;
      }
      const payload = context.render(desired, context.emojis);
      await message.edit({ embeds: payload.embeds, components: payload.components });
      await prisma.discordManagedResource.update({
        where: { id: entry.id },
        data: { contentHash: panelHash(payload), lastVerifiedAt: new Date() },
      });
      await recordAudit(prisma, actor, {
        action: 'PANEL_UPDATED',
        entityType: 'discord_resource',
        entityId: entry.logicalKey,
        entityLabel: entry.logicalKey,
        metadata: { channelId: entry.channelId, messageId: entry.discordResourceId },
      });
      updated += 1;
    }
    await interaction.editReply({
      embeds: [
        xenonEmbed(missing.length > 0 ? 'warning' : 'success')
          .setTitle('XENON PANELS REFRESHED')
          .setDescription(
            `${String(updated)} existing panel${updated === 1 ? '' : 's'} edited in place.${missing.length > 0 ? `\n${String(missing.length)} missing or unavailable: ${missing.slice(0, 8).join(', ')}. Run /xenon panel repair to restore them.` : ''}`,
          ),
      ],
    });
    return;
  }

  if (sub === 'status') {
    const guild = await interaction.client.guilds.fetch(guildId);
    const context = await loadProvisioningContext(guild);
    const panels = await prisma.discordManagedResource.findMany({
      where: { guildId, resourceType: 'PANEL', managed: true },
      orderBy: { logicalKey: 'asc' },
    });
    const lines: string[] = [];
    for (const entry of panels.slice(0, 20)) {
      if (entry.discordResourceId === null || entry.channelId === null) {
        lines.push(`◦ ${entry.logicalKey} · missing reference`);
        continue;
      }
      const channel = await interaction.client.channels.fetch(entry.channelId).catch(() => null);
      const message =
        channel?.isTextBased() && 'messages' in channel
          ? await channel.messages.fetch(entry.discordResourceId).catch(() => null)
          : null;
      const desired = context.state.panels.find((panel) => panel.key === entry.logicalKey);
      const hash =
        desired === undefined ? null : panelHash(context.render(desired, context.emojis));
      lines.push(
        `◦ ${entry.logicalKey} · ${message === null ? 'missing' : hash === entry.contentHash ? 'ready' : 'needs refresh'}`,
      );
    }
    await interaction.editReply({
      embeds: [
        xenonEmbed(lines.some((line) => !line.endsWith('ready')) ? 'warning' : 'success')
          .setTitle('XENON PANEL STATUS')
          .setDescription(
            lines.length === 0
              ? 'No panels are registered. Run /xenon panel setup.'
              : lines.join('\n'),
          ),
      ],
    });
    return;
  }

  await interaction.editReply('That panel command is not available.');
}

async function handleAutomod(
  interaction: ChatInputCommandInteraction,
  actor: Actor,
  sub: string,
): Promise<void> {
  const features = await blueprintFeatures(prisma);
  if (sub === 'enable' || sub === 'disable') {
    await saveBlueprintFeatures(prisma, actor, { ...features, automod: sub === 'enable' });
  }
  if (sub === 'disable' && interaction.guild !== null) {
    // Disabling turns rules off in Discord but never deletes them: an
    // operator can inspect or re-enable exactly what was there.
    const rules = await prisma.discordManagedResource.findMany({
      where: {
        guildId: interaction.guild.id,
        resourceType: 'AUTOMOD',
        managed: true,
        discordResourceId: { not: null },
      },
    });
    for (const rule of rules) {
      if (rule.discordResourceId === null) continue;
      await interaction.guild.autoModerationRules
        .edit(rule.discordResourceId, {
          enabled: false,
          reason: 'Xenon AutoMod disabled',
        })
        .catch(() => undefined);
    }
  }
  const rules = await prisma.discordManagedResource.findMany({
    where: { guildId: interaction.guildId ?? '', resourceType: 'AUTOMOD' },
    select: { logicalKey: true },
  });
  await interaction.editReply({
    embeds: [
      xenonEmbed(sub === 'disable' ? 'neutral' : 'info')
        .setTitle('AUTOMOD')
        .setDescription(
          sub === 'enable'
            ? 'AutoMod is part of the blueprint again. Run `/xenon setup plan` to review the rules, then apply.'
            : sub === 'disable'
              ? 'Xenon AutoMod rules are disabled in Discord and left out of future plans. Nothing was deleted.'
              : `${features.automod ? 'Enabled' : 'Disabled'} in the blueprint. ${String(rules.length)} Xenon rules recorded. Rules block and alert; they never ban.`,
        ),
    ],
  });
}

function confirmModal(mode: 'apply' | 'repair', run: DiscordProvisionRun): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(xenonIds.setupConfirm(mode, run.id))
    .setTitle(mode === 'apply' ? 'Apply Xenon provisioning' : 'Repair Xenon resources')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel(`This will modify the server. Type ${PROVISION_PHRASE}`)
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('confirmation')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(40),
        ),
    );
  if (planProfile(run.plannedChanges) === 'ESTABLISHED') {
    modal.addLabelComponents(
      new LabelBuilder()
        .setLabel('Existing server. Type ESTABLISHED to confirm')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('established')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(20),
        ),
    );
  }
  return modal;
}

/** Buttons and modals under `xn:setup:*`. */
export async function handleSetupComponent(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  id: XenonId,
): Promise<void> {
  const runId = id.argument;
  const mode = id.action.endsWith('repair') ? 'repair' : 'apply';
  const actor = await provisioningActor(interaction);
  if (actor === null || runId === null) {
    await interaction.reply({
      content: 'You cannot provision this server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const basis = await prisma.discordProvisionRun.findUnique({ where: { id: runId } });
  if (basis?.mode !== 'PLAN' || basis.guildId !== interaction.guildId) {
    await interaction.reply({
      content: 'That plan no longer exists. Run `/xenon setup plan` again.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.isButton()) {
    await interaction.showModal(confirmModal(mode, basis));
    return;
  }

  const confirmation = interaction.fields.getTextInputValue('confirmation');
  if (confirmation.trim() !== PROVISION_PHRASE) {
    await interaction.reply({
      content: `Nothing changed. The phrase must be exactly ${PROVISION_PHRASE}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const established = planProfile(basis.plannedChanges) === 'ESTABLISHED';
  if (established && interaction.fields.getTextInputValue('established').trim() !== 'ESTABLISHED') {
    await interaction.reply({
      content: 'Nothing changed. Confirm the existing server by typing ESTABLISHED.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const includeSoft = (basis.options as { includeSoft?: boolean } | null)?.includeSoft === true;
    const panelOnly = (basis.options as { scope?: string } | null)?.scope === 'panels';
    const onlyKeys = panelOnly
      ? new Set(
          planItems(basis.plannedChanges)
            .filter((item) => item.resourceType === 'PANEL')
            .map((item) => item.key),
        )
      : undefined;
    const run = await runNow(
      interaction,
      actor,
      mode === 'apply' ? 'APPLY' : 'REPAIR',
      {
        basedOnRunId: basis.id,
        confirmation,
        acknowledgeEstablished: established,
        includeSoft,
      },
      onlyKeys === undefined ? {} : { onlyKeys },
    );
    await interaction.editReply({
      embeds: [buildRunEmbed(run)],
      components: reviewButtons(run, 'apply').map((row) =>
        row.setComponents(row.components.slice(-1)),
      ),
    });
  } catch (error) {
    logger.warn({ err: error, runId }, 'Setup confirmation failed');
    await interaction.editReply(toSafeMessage(error));
  }
}
