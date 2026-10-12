import { answerToText, toQuestionDefinition } from '@xenon/applications';
import type { Db } from '@xenon/database';
import { buildReviewActions, buildReviewEmbed } from '@xenon/discord';
import type { Logger } from '@xenon/logger';

import { DiscordRequestError, type GatewayCall, GatewayError } from './gateway-client';
import { gatewayMessage } from './message';

/**
 * The staff review card.
 *
 * Posted when an application is submitted and edited in place on every state
 * change through the stored `DiscordMessageReference`: without the pointer an
 * approval would post a second message rather than updating the first.
 *
 * Rendered from the current row each time, so a job that sat in the queue
 * through three state changes delivers the state that is true when it runs.
 * Xenon Link sends and edits the message; the worker owns the database rows.
 */

export interface ReviewCardDeps {
  readonly db: Db;
  readonly gateway: GatewayCall;
  readonly logger: Logger;
  readonly siteUrl: string;
  /** `DISCORD_GUILD_ID`: the one guild the primary guild row must match. */
  readonly guildId: string;
}

/** The first few long answers, for triage without opening the site. */
async function highlights(
  db: Db,
  submissionId: string,
): Promise<{ label: string; value: string }[]> {
  const answers = await db.applicationAnswer.findMany({
    where: { submissionId, question: { type: 'LONG_TEXT', staffOnly: false } },
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

async function renderCard(deps: ReviewCardDeps, submissionId: string) {
  const submission = await deps.db.applicationSubmission.findUnique({
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

  const lastEvent = submission.events[0];
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
      lastEvent === undefined
        ? null
        : {
            actorName: lastEvent.actor?.displayName ?? lastEvent.actor?.publicId ?? 'Xenon system',
            at: lastEvent.createdAt,
          },
    siteUrl: deps.siteUrl,
    highlights: await highlights(deps.db, submissionId),
  });

  return {
    submission,
    embeds: [embed.toJSON()],
    components: buildReviewActions(submission.publicId, submission.status, deps.siteUrl).map(
      (row) => row.toJSON(),
    ),
  };
}

/** A failure that a fresh post cannot fix: Link or Discord is down. */
function isTransient(error: unknown): boolean {
  return (
    (error instanceof GatewayError && error.retryable) ||
    (error instanceof DiscordRequestError && error.retryable)
  );
}

/**
 * Post the card, or edit the existing one.
 *
 * Idempotent: the job id for `discord.review.post` collapses duplicate
 * enqueues, and the stored reference means a retry after a partial failure
 * edits rather than duplicates.
 */
export async function postOrUpdateReviewCard(
  deps: ReviewCardDeps,
  submissionId: string,
): Promise<void> {
  const { db, gateway, logger } = deps;
  const card = await renderCard(deps, submissionId);
  if (card === null) {
    logger.warn({ submissionId }, 'Submission disappeared before its card could be rendered');
    return;
  }

  const primaryGuild = await db.discordGuild.findFirst({ where: { isPrimary: true } });
  if (primaryGuild?.guildId !== deps.guildId) {
    logger.error(
      { submissionId, configuredGuildId: deps.guildId },
      'Review card delivery has no matching configured Xenon guild',
    );
    if (primaryGuild !== null) {
      await db.discordGuild.update({
        where: { id: primaryGuild.id },
        data: { syncError: 'Review card delivery has no matching configured Xenon guild' },
      });
    }
    return;
  }

  const existing = await db.discordMessageReference.findFirst({
    where: { submissionId, kind: 'APPLICATION_REVIEW', deletedAt: null },
  });

  if (existing !== null) {
    try {
      const { found } = await gateway('message.edit', {
        channelId: existing.channelId,
        messageId: existing.messageId,
        message: gatewayMessage({ embeds: card.embeds, components: card.components }),
      });
      if (found) {
        await db.discordGuild.update({ where: { id: primaryGuild.id }, data: { syncError: null } });
        return;
      }
      logger.warn({ submissionId }, 'Stored review message is gone, reposting');
    } catch (error) {
      if (isTransient(error)) throw error;
      // The channel is gone or no longer in the configured guild. Forget the
      // pointer and post a new card rather than failing the job forever.
      logger.warn({ err: error, submissionId }, 'Stored review message is unusable, reposting');
    }
    await db.discordMessageReference.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() },
    });
  }

  const channelId = card.submission.template.reviewChannelId ?? primaryGuild.reviewChannelId;
  if (channelId === null) {
    logger.warn(
      { submissionId },
      'No review channel configured; skipping the card. Set one in /control/discord.',
    );
    return;
  }

  const pingRole = card.submission.template.notifyRoleId;
  let sent;
  try {
    sent = await gateway('message.send', {
      target: { kind: 'channel', channelId },
      message: gatewayMessage({
        ...(pingRole === null
          ? {}
          : { content: `<@&${pingRole}>`, allowedRoleMentions: [pingRole] }),
        embeds: card.embeds,
        components: card.components,
      }),
    });
  } catch (error) {
    if (isTransient(error)) throw error;
    const message =
      'Review channel is missing or is not a text channel in the configured Xenon guild';
    logger.error({ err: error, channelId, guildId: primaryGuild.guildId }, message);
    await db.discordGuild.update({ where: { id: primaryGuild.id }, data: { syncError: message } });
    return;
  }

  await db.discordGuild.update({ where: { id: primaryGuild.id }, data: { syncError: null } });
  await db.discordMessageReference.create({
    data: {
      kind: 'APPLICATION_REVIEW',
      channelId: sent.channelId,
      messageId: sent.messageId,
      submissionId,
    },
  });
}
