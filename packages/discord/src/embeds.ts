import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type APIEmbedField,
} from 'discord.js';

import { brand } from '@xenon/config';
import type { ApplicationStatus } from '@xenon/database';

/**
 * Discord presentation.
 *
 * Embeds are built here rather than inline at each interaction handler so that
 * the review card looks identical whether it was posted by the submission job,
 * edited by an approval, or re-rendered by a manual `/review` command. Colours
 * come from `@xenon/config`, the same constants the website's CSS tokens use.
 */

const XENON_ICON = undefined;

export interface ReviewCardInput {
  readonly publicId: string;
  readonly templateName: string;
  readonly status: ApplicationStatus;
  readonly applicant: {
    readonly publicId: string;
    readonly displayName: string | null;
    readonly discordId: string | null;
    readonly accountAgeDays: number;
    readonly isGuildMember: boolean;
    readonly whitelistState: string;
  };
  readonly characterName: string | null;
  readonly submittedAt: Date | null;
  readonly attempt: number;
  readonly assigneeName: string | null;
  readonly decisionNote: string | null;
  readonly siteUrl: string;
  /** A short preview of the first few answers, for triage at a glance. */
  readonly highlights: readonly { label: string; value: string }[];
}

const statusColour: Record<ApplicationStatus, number> = {
  DRAFT: brand.state.neutralInt,
  SUBMITTED: brand.state.infoInt,
  UNDER_REVIEW: brand.state.infoInt,
  CHANGES_REQUESTED: brand.state.warningInt,
  RESUBMITTED: brand.state.infoInt,
  INTERVIEW_REQUIRED: brand.state.warningInt,
  INTERVIEW_SCHEDULED: brand.state.infoInt,
  INTERVIEW_COMPLETED: brand.state.infoInt,
  APPROVED: brand.state.successInt,
  REJECTED: brand.state.dangerInt,
  WITHDRAWN: brand.state.neutralInt,
  EXPIRED: brand.state.neutralInt,
  ARCHIVED: brand.state.neutralInt,
};

const statusLabel: Record<ApplicationStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Awaiting review',
  UNDER_REVIEW: 'Under review',
  CHANGES_REQUESTED: 'Changes requested',
  RESUBMITTED: 'Resubmitted',
  INTERVIEW_REQUIRED: 'Interview required',
  INTERVIEW_SCHEDULED: 'Interview scheduled',
  INTERVIEW_COMPLETED: 'Interview completed',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
  EXPIRED: 'Expired',
  ARCHIVED: 'Archived',
};

/** Discord truncates silently at 1024 per field; do it visibly instead. */
function clamp(value: string, max = 1000): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function buildReviewEmbed(input: ReviewCardInput): EmbedBuilder {
  const fields: APIEmbedField[] = [
    {
      name: 'Applicant',
      value: [
        input.applicant.displayName ?? input.applicant.publicId,
        input.applicant.discordId === null ? null : `<@${input.applicant.discordId}>`,
        `\`${input.applicant.publicId}\``,
      ]
        .filter((line): line is string => line !== null)
        .join('\n'),
      inline: true,
    },
    {
      name: 'Type',
      value: `${input.templateName}${input.attempt > 1 ? `\nAttempt ${String(input.attempt)}` : ''}`,
      inline: true,
    },
    {
      name: 'Status',
      value: statusLabel[input.status],
      inline: true,
    },
    {
      // The three signals a reviewer checks first, so they are on the card and
      // not one click away.
      name: 'Account',
      value: [
        `Age: ${String(input.applicant.accountAgeDays)}d`,
        `Guild: ${input.applicant.isGuildMember ? 'yes' : 'no'}`,
        `Whitelist: ${input.applicant.whitelistState.toLowerCase()}`,
      ].join('\n'),
      inline: true,
    },
  ];

  if (input.characterName !== null) {
    fields.push({ name: 'Character', value: input.characterName, inline: true });
  }
  if (input.assigneeName !== null) {
    fields.push({ name: 'Reviewer', value: input.assigneeName, inline: true });
  }

  for (const highlight of input.highlights.slice(0, 3)) {
    fields.push({ name: highlight.label, value: clamp(highlight.value, 400), inline: false });
  }

  if (input.decisionNote !== null) {
    fields.push({ name: 'Decision note', value: clamp(input.decisionNote, 600), inline: false });
  }

  const embed = new EmbedBuilder()
    .setColor(statusColour[input.status])
    .setAuthor({ name: `${brand.shortName} · Application review`, iconURL: XENON_ICON })
    .setTitle(input.publicId)
    .setURL(`${input.siteUrl}/control/applications/${input.publicId}`)
    .addFields(fields)
    .setFooter({ text: `${brand.wordmark} · ${input.publicId}` });

  if (input.submittedAt !== null) embed.setTimestamp(input.submittedAt);
  return embed;
}

/**
 * Action row for a review card.
 *
 * The custom id carries the submission's public identifier, which is what lets
 * a button clicked three weeks later still resolve - Discord message state is
 * not storage, so the id in the button is the only durable link back to the row.
 * Buttons disappear entirely once a decision is final, so there is no path to
 * clicking Approve on something already rejected.
 */
export function buildReviewActions(
  publicId: string,
  status: ApplicationStatus,
): ActionRowBuilder<ButtonBuilder>[] {
  const decided =
    status === 'APPROVED' ||
    status === 'REJECTED' ||
    status === 'WITHDRAWN' ||
    status === 'EXPIRED' ||
    status === 'ARCHIVED';

  if (decided) return [];

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`app:claim:${publicId}`)
      .setLabel('Claim')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`app:approve:${publicId}`)
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`app:interview:${publicId}`)
      .setLabel('Interview')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`app:changes:${publicId}`)
      .setLabel('Request changes')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`app:reject:${publicId}`)
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger),
  );

  return [row];
}

export interface NotificationEmbedInput {
  readonly title: string;
  readonly body: string;
  readonly href: string | null;
  readonly siteUrl: string;
  readonly tone: 'success' | 'danger' | 'warning' | 'info' | 'neutral';
}

const toneColour = {
  success: brand.state.successInt,
  danger: brand.state.dangerInt,
  warning: brand.state.warningInt,
  info: brand.state.infoInt,
  neutral: brand.state.neutralInt,
} as const;

export function buildNotificationEmbed(input: NotificationEmbedInput): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(toneColour[input.tone])
    .setAuthor({ name: brand.wordmark })
    .setTitle(input.title)
    .setDescription(clamp(input.body, 3800))
    .setTimestamp(new Date());

  if (input.href !== null) {
    embed.setURL(input.href.startsWith('http') ? input.href : `${input.siteUrl}${input.href}`);
  }

  return embed;
}

export interface StatusEmbedInput {
  readonly aggregate: 'ONLINE' | 'OFFLINE' | 'DEGRADED' | 'UNKNOWN';
  readonly servers: readonly {
    name: string;
    state: string;
    playerCount: number | null;
    maxPlayers: number | null;
    queueLength: number | null;
  }[];
  readonly checkedAt: string | null;
  readonly connectUrl: string | null;
}

/**
 * Server status embed.
 *
 * Renders "unavailable" rather than a zero when there is no reading. A status
 * board that says "0 players" when the poller is broken is worse than one that
 * admits it does not know.
 */
export function buildStatusEmbed(input: StatusEmbedInput): EmbedBuilder {
  const colour =
    input.aggregate === 'ONLINE'
      ? brand.state.successInt
      : input.aggregate === 'DEGRADED'
        ? brand.state.warningInt
        : input.aggregate === 'OFFLINE'
          ? brand.state.dangerInt
          : brand.state.neutralInt;

  const embed = new EmbedBuilder()
    .setColor(colour)
    .setAuthor({ name: `${brand.wordmark} · City status` })
    .setTitle(
      input.aggregate === 'ONLINE'
        ? 'City online'
        : input.aggregate === 'OFFLINE'
          ? 'City offline'
          : input.aggregate === 'DEGRADED'
            ? 'Partially available'
            : 'Status unavailable',
    );

  if (input.servers.length === 0) {
    embed.setDescription('No game server is configured yet.');
    return embed;
  }

  for (const server of input.servers) {
    const players =
      server.playerCount === null
        ? 'unavailable'
        : `${String(server.playerCount)}${server.maxPlayers === null ? '' : ` / ${String(server.maxPlayers)}`}`;

    embed.addFields({
      name: server.name,
      value: [
        `State: ${server.state.toLowerCase()}`,
        `Players: ${players}`,
        server.queueLength === null || server.queueLength === 0
          ? null
          : `Queue: ${String(server.queueLength)}`,
      ]
        .filter((line): line is string => line !== null)
        .join('\n'),
      inline: true,
    });
  }

  if (input.connectUrl !== null && input.connectUrl.length > 0) {
    embed.addFields({ name: 'Connect', value: input.connectUrl, inline: false });
  }
  if (input.checkedAt !== null) embed.setTimestamp(new Date(input.checkedAt));

  return embed;
}
