import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const queuedEffects = vi.hoisted(() => [] as { name: string; payload: unknown }[]);
const enqueueEffect = vi.hoisted(() =>
  vi.fn((name: string, payload: unknown) => {
    queuedEffects.push({ name, payload });
    return Promise.resolve(true);
  }),
);

vi.mock('@xenon/jobs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as Record<string, unknown>), enqueueBestEffort: enqueueEffect };
});

import {
  approveApplication,
  autosave,
  startApplication,
  submitApplication,
} from '@xenon/applications';
import { prisma } from '@xenon/database';
import { buildReviewActions, buildReviewEmbed } from '@xenon/discord';
import { resolveActor } from '@xenon/permissions';

import {
  actorFor,
  createActor,
  createTemplate,
  fillRequiredAnswers,
  resetDatabase,
} from './harness';

const SITE_URL = 'https://xenon.example.test';

interface FakeReviewMessage {
  readonly messageId: string;
  payload: {
    readonly embed: ReturnType<typeof buildReviewEmbed>['data'];
    readonly components: unknown[];
  };
}

/** Fake Discord adapter used to exercise the persisted review-message boundary. */
class FakeDiscordAdapter {
  readonly messages = new Map<string, FakeReviewMessage>();
  #nextMessage = 0;

  async createOrUpdate(submissionId: string): Promise<FakeReviewMessage> {
    const submission = await prisma.applicationSubmission.findUniqueOrThrow({
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

    const input = {
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
        guildMembershipState:
          submission.applicant.discordAccount?.guildMembershipState ?? 'UNKNOWN',
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
      siteUrl: SITE_URL,
      highlights: [],
    };

    const existing = await prisma.discordMessageReference.findFirst({
      where: { submissionId, kind: 'APPLICATION_REVIEW', deletedAt: null },
    });
    const messageId =
      existing?.messageId ?? `900000000000000${String(++this.#nextMessage).padStart(3, '0')}`;
    if (existing === null) {
      await prisma.discordMessageReference.create({
        data: {
          kind: 'APPLICATION_REVIEW',
          channelId: '900000000000000101',
          messageId,
          submissionId,
        },
      });
    }

    const message: FakeReviewMessage = {
      messageId,
      payload: {
        embed: buildReviewEmbed(input).toJSON(),
        components: buildReviewActions(submission.publicId, submission.status, SITE_URL).map(
          (row) => row.toJSON(),
        ),
      },
    };
    this.messages.set(submissionId, message);
    return message;
  }
}

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  queuedEffects.length = 0;
  enqueueEffect.mockClear();
  await resetDatabase();
});

describe('website submission to Discord review and back', () => {
  it('keeps Discord as a view of the canonical Xenon application state', async () => {
    const template = await createTemplate({ grantsWhitelist: true, grantRoleKeys: ['member'] });
    const { user: applicant } = await createActor({ displayName: 'Discord Flow Applicant' });
    const { user: reviewer } = await createActor({
      displayName: 'Discord Flow Reviewer',
      roleKeys: ['reviewer'],
    });
    await prisma.discordGuild.create({
      data: {
        guildId: '900000000000000100',
        name: 'Fake Xenon Guild',
        isPrimary: true,
        reviewChannelId: '900000000000000101',
      },
    });

    const draft = await startApplication(prisma, await actorFor(applicant), template.slug);
    await autosave(prisma, await actorFor(applicant), {
      submissionId: draft.id,
      revision: 0,
      answers: await fillRequiredAnswers(prisma, draft.id),
    });
    const submitted = await submitApplication(prisma, await actorFor(applicant), draft.id);
    expect(submitted.status).toBe('SUBMITTED');
    expect(queuedEffects).toContainEqual({
      name: 'discord.review.post',
      payload: { submissionId: draft.id },
    });

    const discord = new FakeDiscordAdapter();
    const initialCard = await discord.createOrUpdate(draft.id);
    expect(initialCard.payload.embed.fields?.find((field) => field.name === 'Status')?.value).toBe(
      'Awaiting review',
    );
    expect(
      await prisma.discordMessageReference.count({
        where: { submissionId: draft.id, kind: 'APPLICATION_REVIEW', deletedAt: null },
      }),
    ).toBe(1);

    // This resolves the same way as actorFromDiscord: snowflake -> account -> Xenon Actor.
    const discordStaffId = (
      await prisma.discordAccount.findUniqueOrThrow({
        where: { userId: reviewer.id },
        select: { discordId: true },
      })
    ).discordId;
    const account = await prisma.discordAccount.findUniqueOrThrow({
      where: { discordId: discordStaffId },
      select: { userId: true },
    });
    const discordActor = await resolveActor(prisma, { userId: account.userId, source: 'DISCORD' });
    if (discordActor === null) throw new Error('Discord staff account did not resolve to Xenon');

    await approveApplication(prisma, discordActor, { reference: submitted.publicId });
    expect(queuedEffects.some((job) => job.name === 'discord.review.update')).toBe(true);
    expect(queuedEffects.some((job) => job.name === 'discord.role.sync')).toBe(true);
    expect(await prisma.notification.count({ where: { userId: applicant.id } })).toBeGreaterThan(0);

    const event = await prisma.applicationEvent.findFirstOrThrow({
      where: { submissionId: draft.id, toStatus: 'APPROVED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event.source).toBe('DISCORD');
    expect(
      await prisma.auditLog.findFirstOrThrow({
        where: { entityId: draft.id, action: 'application.approved' },
        select: { source: true },
      }),
    ).toEqual({ source: 'DISCORD' });

    const approvedCard = await discord.createOrUpdate(draft.id);
    expect(approvedCard.messageId).toBe(initialCard.messageId);
    expect(approvedCard.payload.embed.fields?.find((field) => field.name === 'Status')?.value).toBe(
      'Approved',
    );
    const rows = approvedCard.payload.components as { components: { custom_id?: string }[] }[];
    expect(
      rows.flatMap((row) => row.components).some((component) => component.custom_id !== undefined),
    ).toBe(false);

    // The portal reads the canonical row directly and immediately sees the same decision.
    expect(
      await prisma.applicationSubmission.findUniqueOrThrow({
        where: { id: draft.id },
        select: { status: true },
      }),
    ).toEqual({ status: 'APPROVED' });
  });
});
