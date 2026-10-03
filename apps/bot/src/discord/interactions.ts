import {
  type ButtonInteraction,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

import {
  approveApplication,
  claimApplication,
  rejectApplication,
  requestChanges,
  requestInterview,
} from '@xenon/applications';
import { toSafeMessage } from '@xenon/core';
import { prisma } from '@xenon/database';
import { loadSupportSettings, xenonEmbed, XenonTicketPanel } from '@xenon/discord';
import { closeOwnTicket } from '@xenon/domain';
import { can } from '@xenon/permissions';

import { botEnv, logger } from '../runtime';

import { actorFromDiscord } from './actor';
import { postOrUpdateReviewCard } from './review-card';

/**
 * Button and modal handling for review cards.
 *
 * Reject, request-changes and interview instructions collect concise notes in
 * a modal. The shared Xenon application services recheck capability and state
 * before they commit anything.
 *
 * Custom ids carry the application's public identifier because Discord message
 * state is not storage: a button clicked three weeks later has nothing else to
 * resolve from.
 *
 * Every handler ends by re-rendering the card, so the message reflects the new
 * state and the buttons disappear once a decision is final.
 */

/** `app:<action>:<publicId>` */
function parseCustomId(customId: string): { action: string; reference: string } | null {
  const [namespace, action, reference] = customId.split(':');
  if (namespace !== 'app' || action === undefined || reference === undefined) return null;
  return { action, reference };
}

function modalFor(action: string, reference: string): ModalBuilder {
  const rejecting = action === 'reject';
  const interviewing = action === 'interview';

  // Discord's current modal shape puts the label on a `LabelBuilder` wrapping
  // the input, rather than on the input itself. The older `setLabel` form still
  // works but is deprecated, and modals are rare enough here that following the
  // current API costs nothing.
  return new ModalBuilder()
    .setCustomId(`app:${action}:${reference}`)
    .setTitle(
      rejecting
        ? `Reject ${reference}`
        : interviewing
          ? `Interview for ${reference}`
          : `Changes for ${reference}`,
    )
    .addLabelComponents(
      new LabelBuilder()
        .setLabel(
          rejecting
            ? 'Reason (the applicant reads this)'
            : interviewing
              ? 'Interview instructions (applicant sees this)'
              : 'What needs changing',
        )
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('publicNote')
            .setStyle(TextInputStyle.Paragraph)
            .setMinLength(interviewing ? 0 : 10)
            .setMaxLength(1800)
            .setRequired(!interviewing),
        ),
      new LabelBuilder()
        .setLabel('Internal note (staff only)')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('staffNote')
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(1800)
            .setRequired(false),
        ),
    );
}

export async function handleButton(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseCustomId(interaction.customId);
  if (parsed === null) return;

  const { action, reference } = parsed;

  // The modal has to be the first response to the interaction, so it is opened
  // before anything is deferred.
  if (action === 'reject' || action === 'changes' || action === 'interview') {
    const actor = await actorFromDiscord(interaction.user.id);
    const permission =
      action === 'reject'
        ? 'applications.reject'
        : action === 'changes'
          ? 'applications.request_changes'
          : 'applications.interview';

    if (!actor.permissions.has(permission)) {
      await interaction.reply({
        content: 'You do not have permission to do that.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.showModal(modalFor(action, reference));
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const actor = await actorFromDiscord(interaction.user.id);

    switch (action) {
      case 'claim':
        await claimApplication(prisma, actor, reference);
        await interaction.editReply(`Claimed ${reference}.`);
        break;

      case 'approve':
        await approveApplication(prisma, actor, { reference });
        await interaction.editReply(
          `Approved ${reference}. The applicant has been notified, and role and whitelist ` +
            'synchronisation is queued.',
        );
        break;

      default:
        await interaction.editReply('That button is no longer supported.');
        return;
    }

    await refreshCard(interaction, reference);
  } catch (error) {
    logger.warn({ err: error, action, reference }, 'Review button failed');
    await interaction.editReply(toSafeMessage(error));
  }
}

export async function handleModal(interaction: ModalSubmitInteraction): Promise<void> {
  const parsed = parseCustomId(interaction.customId);
  if (parsed === null) return;

  const { action, reference } = parsed;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const actor = await actorFromDiscord(interaction.user.id);
    const publicNote = interaction.fields.getTextInputValue('publicNote');
    const staffNote = interaction.fields.getTextInputValue('staffNote');

    if (action === 'reject') {
      await rejectApplication(prisma, actor, { reference, publicNote, staffNote });
      await interaction.editReply(`Rejected ${reference}. The applicant has been told why.`);
    } else if (action === 'changes') {
      await requestChanges(prisma, actor, { reference, publicNote, staffNote });
      await interaction.editReply(`${reference} sent back for changes.`);
    } else if (action === 'interview') {
      await requestInterview(prisma, actor, {
        reference,
        publicNote: publicNote.trim() || null,
        staffNote: staffNote.trim() || null,
      });
      await interaction.editReply(`${reference} moved to the interview stage.`);
    } else {
      await interaction.editReply('That modal is no longer supported.');
      return;
    }

    await refreshCard(interaction, reference);
  } catch (error) {
    logger.warn({ err: error, action, reference }, 'Review modal failed');
    await interaction.editReply(toSafeMessage(error));
  }
}

function siteLink(path: string): string {
  return new URL(path, botEnv.NEXT_PUBLIC_SITE_URL).toString();
}

/** Public support/application menus only link to canonical Xenon workflows. */
export async function handleStringSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const selected = interaction.values[0];
  if (selected === undefined) {
    await interaction.reply({
      content: 'That selection is no longer available.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.customId === 'xn:support:category') {
    if (selected === 'DEVELOPER') {
      const actor = await actorFromDiscord(interaction.user.id);
      if (!can(actor, 'tickets.view') && !can(actor, 'system.discord.bootstrap')) {
        await interaction.reply({
          content: 'Developer support is available to Xenon staff only.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await sendWorkflowLink(
        interaction,
        'Open Xenon Control to review the developer support queue.',
        '/control/tickets',
      );
      return;
    }

    const paths: Record<string, string> = {
      GENERAL: '/support?category=GENERAL',
      TECHNICAL: '/support?category=TECHNICAL',
      CHARACTER: '/support?category=ACCOUNT',
      WHITELIST: '/support?category=WHITELIST',
      BUSINESS: '/support?category=GENERAL',
      PLAYER_REPORT: '/support?tab=report&kind=PLAYER',
      STAFF_REPORT: '/support?tab=report&kind=STAFF',
    };
    const path = paths[selected];
    if (path === undefined) {
      await interaction.reply({
        content: 'That support category is no longer available.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await sendWorkflowLink(
      interaction,
      'Your ticket and replies stay in your Xenon player portal.',
      path,
    );
    return;
  }

  if (interaction.customId === 'xn:application:open') {
    const template = await prisma.applicationTemplate.findUnique({
      where: { slug: selected },
      select: { slug: true, status: true, archivedAt: true, opensAt: true, closesAt: true },
    });
    if (template === null) {
      await interaction.reply({
        content: 'That application is no longer open. Refresh the panel for current openings.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const now = Date.now();
    const opensAt = template.opensAt?.getTime();
    const closesAt = template.closesAt?.getTime();
    if (
      template.status !== 'OPEN' ||
      template.archivedAt !== null ||
      (opensAt !== undefined && opensAt > now) ||
      (closesAt !== undefined && closesAt <= now)
    ) {
      await interaction.reply({
        content: 'That application is no longer open. Refresh the panel for current openings.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await sendWorkflowLink(
      interaction,
      'Continue your application on the Xenon website.',
      `/applications/${template.slug}`,
    );
    return;
  }

  await interaction.reply({
    content: 'This Xenon selection is no longer available.',
    flags: MessageFlags.Ephemeral,
  });
}

async function sendWorkflowLink(
  interaction: StringSelectMenuInteraction,
  copy: string,
  path: string,
): Promise<void> {
  const button = new ButtonBuilder()
    .setLabel('CONTINUE IN XENON')
    .setStyle(ButtonStyle.Link)
    .setURL(siteLink(path));
  await interaction.reply({
    embeds: [xenonEmbed().setTitle('XENON').setDescription(copy).toJSON()],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button).toJSON()],
    flags: MessageFlags.Ephemeral,
  });
}

/** Ticket close is authorized by the canonical Xenon ticket service. */
export async function handleTicketClose(
  interaction: ButtonInteraction,
  publicId: string,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const settings = await loadSupportSettings(prisma);
    if (!settings.allowDiscordClose) {
      await interaction.editReply(
        'Ticket closing from Discord is disabled. Use the Xenon player portal.',
      );
      return;
    }
    const actor = await actorFromDiscord(interaction.user.id);
    const ticket = await closeOwnTicket(prisma, actor, publicId);
    const result = XenonTicketPanel({
      ticketId: ticket.publicId,
      category: ticket.category.toLowerCase().replaceAll('_', ' '),
      createdBy: 'You',
      createdAt: ticket.createdAt,
      portalUrl: siteLink(`/portal/tickets/${ticket.publicId}`),
      closed: true,
    });
    await interaction.message.edit({ embeds: result.embeds, components: result.components });
    await interaction.editReply(`Ticket ${ticket.publicId} is closed.`);
  } catch (error) {
    logger.warn({ err: error, publicId }, 'Discord ticket close failed');
    await interaction.editReply(toSafeMessage(error));
  }
}

/**
 * Re-render the card after a decision.
 *
 * Best effort on purpose. The decision is already committed in Postgres; a
 * failure to redraw a Discord message must not turn into an error the staff
 * member reads as "that did not work".
 */
async function refreshCard(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  reference: string,
): Promise<void> {
  try {
    const submission = await prisma.applicationSubmission.findUnique({
      where: { publicId: reference },
      select: { id: true },
    });

    if (submission !== null && interaction.client.isReady()) {
      await postOrUpdateReviewCard(interaction.client, submission.id);
    }
  } catch (error) {
    logger.warn({ err: error, reference }, 'Could not refresh the review card');
  }
}
