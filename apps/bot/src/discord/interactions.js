import {
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
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
import { logger } from '../runtime';
import { actorFromDiscord } from './actor';
import { postOrUpdateReviewCard } from './review-card';
/**
 * Button and modal handling for review cards.
 *
 * The flow for a decision that needs a reason - reject, request changes - is
 * button, modal, submit. The reason is mandatory in the service, so collecting
 * it in a modal is the only way a Discord click can produce a decision the
 * applicant can actually understand.
 *
 * Custom ids carry the application's public identifier because Discord message
 * state is not storage: a button clicked three weeks later has nothing else to
 * resolve from.
 *
 * Every handler ends by re-rendering the card, so the message reflects the new
 * state and the buttons disappear once a decision is final.
 */
/** `app:<action>:<publicId>` */
function parseCustomId(customId) {
  const [namespace, action, reference] = customId.split(':');
  if (namespace !== 'app' || action === undefined || reference === undefined) return null;
  return { action, reference };
}
function modalFor(action, reference) {
  const rejecting = action === 'reject';
  // Discord's current modal shape puts the label on a `LabelBuilder` wrapping
  // the input, rather than on the input itself. The older `setLabel` form still
  // works but is deprecated, and modals are rare enough here that following the
  // current API costs nothing.
  return new ModalBuilder()
    .setCustomId(`app:${action}:${reference}`)
    .setTitle(rejecting ? `Reject ${reference}` : `Changes for ${reference}`)
    .addLabelComponents(
      new LabelBuilder()
        .setLabel(rejecting ? 'Reason (the applicant reads this)' : 'What needs changing')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('publicNote')
            .setStyle(TextInputStyle.Paragraph)
            .setMinLength(10)
            .setMaxLength(1800)
            .setRequired(true),
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
export async function handleButton(interaction) {
  const parsed = parseCustomId(interaction.customId);
  if (parsed === null) return;
  const { action, reference } = parsed;
  // The modal has to be the first response to the interaction, so it is opened
  // before anything is deferred.
  if (action === 'reject' || action === 'changes') {
    const actor = await actorFromDiscord(interaction.user.id);
    const permission = action === 'reject' ? 'applications.reject' : 'applications.request_changes';
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
      case 'interview':
        await requestInterview(prisma, actor, { reference });
        await interaction.editReply(`${reference} moved to the interview stage.`);
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
export async function handleModal(interaction) {
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
    } else {
      await requestChanges(prisma, actor, { reference, publicNote, staffNote });
      await interaction.editReply(`${reference} sent back for changes.`);
    }
    await refreshCard(interaction, reference);
  } catch (error) {
    logger.warn({ err: error, action, reference }, 'Review modal failed');
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
async function refreshCard(interaction, reference) {
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
//# sourceMappingURL=interactions.js.map
