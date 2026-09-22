import { ChannelType, type Client } from 'discord.js';

import { answerToText, toQuestionDefinition } from '@xenon/applications';
import { prisma } from '@xenon/database';
import { buildReviewActions, buildReviewEmbed } from '@xenon/discord';

import { botEnv, logger } from '../runtime';

/**
 * The staff review card.
 *
 * Posted when an application is submitted and edited in place on every state
 * change, which is what `DiscordMessageReference` exists for: without a stored
 * pointer, an approval would post a second message rather than updating the
 * first, and a busy channel would become a log of every transition.
 *
 * The card is rendered from the current row each time it is built, so a job
 * that sat in the queue through three state changes delivers the state that is
 * true when it runs.
 */

/** The first few long answers, for triage without opening the site. */
async function highlights(submissionId: string): Promise<{ label: string; value: string }[]> {
  const answers = await prisma.applicationAnswer.findMany({
    where: {
      submissionId,
      question: { type: 'LONG_TEXT', staffOnly: false },
    },
    include: { question: { include: { options: true } } },
    take: 3,
  });

  return answers.flatMap((answer) => {
    const text = answerToText(
      { ...toQuestionDefinition(answer.question), helpText: null, placeholder: null, sortOrder: 0 },
      {
        textValue: answer.textValue,
        numberValue: answer.numberValue,
        booleanValue: answer.booleanValue,
        dateValue: answer.dateValue,
        choiceValues: answer.choiceValues,
        mediaIds: answer.mediaIds,
      },
    );

    return text === null ? [] : [{ label: answer.question.label, value: text }];
  });
}

/** Build the embed and buttons for a submission. Null when it is gone. */
async function renderCard(submissionId: string) {
  const submission = await prisma.applicationSubmission.findUnique({
    where: { id: submissionId },
    include: {
      template: true,
      applicant: {
        select: {
          publicId: true,
          displayName: true,
          createdAt: true,
          whitelistState: true,
          discordAccount: { select: { discordId: true, guildMembershipState: true } },
        },
      },
      character: { select: { firstName: true, lastName: true } },
      assignee: { select: { displayName: true, publicId: true } },
      events: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: { actor: { select: { displayName: true, publicId: true } } },
      },
    },
  });

  if (submission === null) return null;

  const embed = buildReviewEmbed({
    publicId: submission.publicId,
    templateName: submission.template.name,
    status: submission.status,
    applicant: {
      publicId: submission.applicant.publicId,
      displayName: submission.applicant.displayName,
      discordId: submission.applicant.discordAccount?.discordId ?? null,
      accountAgeDays: Math.floor(
        (Date.now() - submission.applicant.createdAt.getTime()) / 86_400_000,
      ),
      guildMembershipState: submission.applicant.discordAccount?.guildMembershipState ?? 'UNKNOWN',
      whitelistState: submission.applicant.whitelistState,
    },
    characterName:
      submission.character === null
        ? null
        : `${submission.character.firstName} ${submission.character.lastName}`,
    submittedAt: submission.submittedAt,
    attempt: submission.attempt,
    assigneeName: submission.assignee?.displayName ?? submission.assignee?.publicId ?? null,
    decisionNote: submission.decisionNote,
    lastAction:
      submission.events[0] === undefined
        ? null
        : {
            actorName:
              submission.events[0].actor?.displayName ??
              submission.events[0].actor?.publicId ??
              'Xenon system',
            at: submission.events[0].createdAt,
          },
    siteUrl: botEnv.NEXT_PUBLIC_SITE_URL,
    highlights: await highlights(submissionId),
  });

  return {
    submission,
    payload: {
      embeds: [embed],
      components: buildReviewActions(
        submission.publicId,
        submission.status,
        botEnv.NEXT_PUBLIC_SITE_URL,
      ),
    },
  };
}

/**
 * Post the card, or edit the existing one.
 *
 * Idempotent by design: the job id for `discord.review.post` collapses
 * duplicate enqueues, and the stored message reference means a retry after a
 * partial failure edits rather than duplicates.
 */
export async function postOrUpdateReviewCard(client: Client, submissionId: string): Promise<void> {
  const card = await renderCard(submissionId);
  if (card === null) {
    logger.warn({ submissionId }, 'Submission disappeared before its card could be rendered');
    return;
  }

  const existing = await prisma.discordMessageReference.findFirst({
    where: { submissionId, kind: 'APPLICATION_REVIEW', deletedAt: null },
  });
  const primaryGuild = await prisma.discordGuild.findFirst({ where: { isPrimary: true } });
  if (
    primaryGuild === null ||
    botEnv.DISCORD_GUILD_ID === undefined ||
    primaryGuild.guildId !== botEnv.DISCORD_GUILD_ID
  ) {
    logger.error(
      { submissionId, configuredGuildId: botEnv.DISCORD_GUILD_ID ?? 'missing' },
      'Review card delivery has no matching configured Xenon guild',
    );
    if (primaryGuild !== null) {
      await prisma.discordGuild.update({
        where: { id: primaryGuild.id },
        data: { syncError: 'Review card delivery has no matching configured Xenon guild' },
      });
    }
    return;
  }

  if (existing !== null) {
    try {
      const channel = await client.channels.fetch(existing.channelId);
      if (
        channel?.type === ChannelType.GuildText &&
        channel.guildId === primaryGuild.guildId &&
        'messages' in channel
      ) {
        const message = await channel.messages.fetch(existing.messageId);
        await message.edit(card.payload);
        await prisma.discordGuild.update({
          where: { id: primaryGuild.id },
          data: { syncError: null },
        });
        return;
      }
      logger.warn(
        { submissionId, channelId: existing.channelId },
        'Stored review card channel is no longer in the configured Xenon guild',
      );
      await prisma.discordMessageReference.update({
        where: { id: existing.id },
        data: { deletedAt: new Date() },
      });
    } catch (error) {
      // The message or channel is gone. Forget the pointer and post a new one
      // rather than failing the job forever.
      logger.warn({ err: error, submissionId }, 'Stored review message is gone, reposting');
      await prisma.discordMessageReference.update({
        where: { id: existing.id },
        data: { deletedAt: new Date() },
      });
    }
  }

  const channelId = card.submission.template.reviewChannelId ?? primaryGuild.reviewChannelId;

  if (channelId === null) {
    logger.warn(
      { submissionId },
      'No review channel configured; skipping the card. Set one in /control/discord.',
    );
    return;
  }

  const guild = await client.guilds.fetch(primaryGuild.guildId);
  const channel = await guild.channels.fetch(channelId);
  if (channel?.type !== ChannelType.GuildText) {
    const message =
      'Review channel is missing or is not a text channel in the configured Xenon guild';
    logger.error({ channelId, guildId: primaryGuild.guildId }, message);
    await prisma.discordGuild.update({
      where: { id: primaryGuild.id },
      data: { syncError: message },
    });
    return;
  }

  await prisma.discordGuild.update({
    where: { id: primaryGuild.id },
    data: { syncError: null },
  });

  const pingRole = card.submission.template.notifyRoleId;
  const message = await channel.send({
    ...card.payload,
    ...(pingRole === null ? {} : { content: `<@&${pingRole}>` }),
  });

  await prisma.discordMessageReference.create({
    data: {
      kind: 'APPLICATION_REVIEW',
      channelId,
      messageId: message.id,
      submissionId,
    },
  });
}
