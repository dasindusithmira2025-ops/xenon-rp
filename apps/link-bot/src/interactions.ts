import {
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Interaction,
  type ModalSubmitInteraction,
} from 'discord.js';

import type { CoreInput } from '@xenon/contracts';
import { parseXenonId } from '@xenon/discord/interaction-ids';
import type { Logger } from '@xenon/logger';

import type { CoreCall } from './core-client';

/**
 * Review-card buttons, review modals and ticket DM buttons.
 *
 * Custom ids carry the application's public reference because Discord message
 * state is not storage: a button clicked three weeks later has nothing else to
 * resolve from. Core re-checks capability and state on every decision; Link
 * only translates the click.
 */

export interface InteractionContext {
  readonly core: CoreCall;
  readonly logger: Logger;
}

/**
 * Opening a modal must be the first response, inside Discord's three-second
 * window, so the authorization check before it gets a tighter budget than a
 * normal Core call.
 */
export const AUTHORIZE_TIMEOUT_MS = 2_000;

const MODAL_ACTIONS = ['reject', 'changes', 'interview'] as const;
type ModalAction = (typeof MODAL_ACTIONS)[number];

function isModalAction(action: string): action is ModalAction {
  return (MODAL_ACTIONS as readonly string[]).includes(action);
}

/** `app:<action>:<reference>` */
export function parseReviewId(customId: string): { action: string; reference: string } | null {
  const [namespace, action, reference, extra] = customId.split(':');
  if (
    namespace !== 'app' ||
    action === undefined ||
    reference === undefined ||
    extra !== undefined ||
    !/^[a-z]{1,16}$/.test(action) ||
    !/^[A-Za-z0-9-]{1,64}$/.test(reference)
  ) {
    return null;
  }
  return { action, reference };
}

export function modalFor(action: ModalAction, reference: string): ModalBuilder {
  const rejecting = action === 'reject';
  const interviewing = action === 'interview';

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

async function handleReviewButton(
  interaction: ButtonInteraction,
  action: string,
  reference: string,
  context: InteractionContext,
): Promise<void> {
  if (isModalAction(action)) {
    const result = await context.core(
      'applications.authorize',
      { actorDiscordId: interaction.user.id, action },
      { timeoutMs: AUTHORIZE_TIMEOUT_MS },
    );
    if (!result.ok || !result.data.allowed) {
      await interaction.reply({
        content: result.ok ? 'You do not have permission to do that.' : result.error.message,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.showModal(modalFor(action, reference));
    return;
  }

  if (action !== 'claim' && action !== 'approve') {
    await interaction.reply({
      content: 'That button is no longer supported.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await context.core('applications.decide', {
    actorDiscordId: interaction.user.id,
    reference,
    action,
  });
  if (!result.ok) {
    await interaction.editReply(result.error.message);
    return;
  }
  await interaction.editReply(
    action === 'claim'
      ? `Claimed ${reference}.`
      : `Approved ${reference}. The applicant has been notified, and role and whitelist ` +
          'synchronisation is queued.',
  );
  await refreshCard(interaction.user.id, reference, context);
}

async function handleReviewModal(
  interaction: ModalSubmitInteraction,
  action: string,
  reference: string,
  context: InteractionContext,
): Promise<void> {
  if (!isModalAction(action)) return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const decision: CoreInput<'applications.decide'> = {
    actorDiscordId: interaction.user.id,
    reference,
    action,
    publicNote: interaction.fields.getTextInputValue('publicNote'),
    staffNote: interaction.fields.getTextInputValue('staffNote'),
  };
  const result = await context.core('applications.decide', decision);
  if (!result.ok) {
    await interaction.editReply(result.error.message);
    return;
  }
  await interaction.editReply(
    action === 'reject'
      ? `Rejected ${reference}. The applicant has been told why.`
      : action === 'changes'
        ? `${reference} sent back for changes.`
        : `${reference} moved to the interview stage.`,
  );
  await refreshCard(interaction.user.id, reference, context);
}

/**
 * Re-render the card after a decision. Best effort on purpose: the decision is
 * already committed, so a failure to queue a redraw must not read as "that did
 * not work".
 */
async function refreshCard(
  actorDiscordId: string,
  reference: string,
  context: InteractionContext,
): Promise<void> {
  const result = await context.core('applications.refreshCard', { actorDiscordId, reference });
  if (!result.ok) {
    context.logger.warn(
      { reference, code: result.error.code },
      'Could not refresh the review card',
    );
  }
}

async function handleTicketClose(
  interaction: ButtonInteraction,
  ticketPublicId: string,
  context: InteractionContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await context.core('tickets.closeOwn', {
    actorDiscordId: interaction.user.id,
    ticketPublicId,
  });
  if (!result.ok) {
    await interaction.editReply(result.error.message);
    return;
  }
  // Remove the buttons so the closed panel cannot be clicked again.
  await interaction.message.edit({ components: [] }).catch((error: unknown) => {
    context.logger.debug({ err: error }, 'Could not clear the ticket panel buttons');
  });
  await interaction.editReply(`Ticket ${result.data.publicId} is closed.`);
}

/** Route a component or modal interaction. Unknown ids are ignored. */
export async function handleComponent(
  interaction: Interaction,
  context: InteractionContext,
): Promise<void> {
  if (!interaction.isButton() && !interaction.isModalSubmit()) return;

  try {
    const xenonId = parseXenonId(interaction.customId);
    if (xenonId !== null) {
      if (
        xenonId.namespace === 'ticket' &&
        xenonId.action === 'close' &&
        xenonId.argument !== null &&
        interaction.isButton()
      ) {
        await handleTicketClose(interaction, xenonId.argument, context);
      }
      return;
    }

    const review = parseReviewId(interaction.customId);
    if (review === null) return;
    if (interaction.isButton()) {
      await handleReviewButton(interaction, review.action, review.reference, context);
    } else {
      await handleReviewModal(interaction, review.action, review.reference, context);
    }
  } catch (error) {
    context.logger.error({ err: error, customId: interaction.customId }, 'Interaction failed');
    const content = 'Something went wrong. Try again shortly.';
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(content).catch(() => undefined);
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
  }
}
