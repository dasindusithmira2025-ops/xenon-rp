import {
  approveApplication,
  claimApplication,
  getOwnApplication,
  listReviewQueue,
  rejectApplication,
  requestChanges,
  requestInterview,
  statusLabels,
} from '@xenon/applications';
import {
  type CoreDomainOperation,
  type CoreOperation,
  type CoreOutput,
  type coreOperations,
} from '@xenon/contracts';
import { ConflictError, NotFoundError, normalisePublicId } from '@xenon/core';
import { transaction, type ApplicationStatus, type Db } from '@xenon/database';
import { loadSupportSettings } from '@xenon/discord';
import { closeOwnTicket, findUserByReference, statusBoard } from '@xenon/domain';
import { cfxConnection } from '@xenon/fivem';
import { emitIntegrationEvent, enqueueDurable } from '@xenon/jobs';
import { type Actor, can, requirePermission } from '@xenon/permissions';

import { actorFromDiscord } from './actor';

import type { z } from 'zod';

/**
 * The Core API operations Xenon Link calls.
 *
 * Each one runs the same domain service the website runs - the capability
 * check, state machine, audit entry and outbox writes live there - so a staff
 * approval from a Discord button and one from /control are one code path with
 * a different `source`. This file only resolves the actor and shapes data for
 * the contract; it never decides anything a service would not.
 */

export type OperationInput<TOp extends CoreOperation> = z.output<
  (typeof coreOperations)[TOp]['input']
>;

export type CoreHandlers = {
  readonly [TOp in CoreDomainOperation]: (input: OperationInput<TOp>) => Promise<CoreOutput<TOp>>;
};

export interface OperationsConfig {
  /** Public website origin, used in user-facing guidance. */
  readonly siteUrl: string;
}

type ReviewAction = OperationInput<'applications.authorize'>['action'];

const REVIEW_PERMISSIONS = {
  reject: 'applications.reject',
  changes: 'applications.request_changes',
  interview: 'applications.interview',
} as const satisfies Record<ReviewAction, string>;

function statusView(submission: { publicId: string; status: ApplicationStatus }) {
  return {
    reference: submission.publicId,
    status: submission.status,
    statusLabel: statusLabels[submission.status],
  };
}

export function createOperations(db: Db, config: OperationsConfig): CoreHandlers {
  /** The account an operation acts for. Link users without one are told to sign in. */
  function requireAccount(actor: Actor): string {
    if (actor.userId === null) {
      throw new ConflictError(
        'Discord user has no Xenon account',
        `Sign in at ${config.siteUrl} with Discord first.`,
      );
    }
    return actor.userId;
  }

  async function findSubmission(reference: string) {
    const publicId = normalisePublicId(reference);
    const submission =
      publicId === null
        ? null
        : await db.applicationSubmission.findUnique({
            where: { publicId },
            select: { id: true },
          });
    if (submission === null) throw new NotFoundError('ApplicationSubmission', reference);
    return submission;
  }

  return {
    async 'status.board'() {
      const [board, setting] = await Promise.all([
        statusBoard(db),
        db.systemSetting.findUnique({ where: { key: 'community.connectUrl' } }),
      ]);
      return {
        aggregate: board.aggregate,
        checkedAt: board.checkedAt,
        connectUrl:
          typeof setting?.value === 'string' && setting.value.length > 0 ? setting.value : null,
        servers: board.servers.map((server) => ({
          name: server.name,
          state: server.state,
          playerCount: server.playerCount,
          maxPlayers: server.maxPlayers,
          queueLength: server.queueLength,
        })),
      };
    },

    async 'players.profile'({ actorDiscordId, targetDiscordId }) {
      // Your own profile needs nothing; somebody else's is a staff read.
      if (targetDiscordId !== actorDiscordId) {
        requirePermission(await actorFromDiscord(db, actorDiscordId), 'players.view');
      }

      const account = await db.discordAccount.findUnique({
        where: { discordId: targetDiscordId },
        select: {
          user: {
            select: {
              publicId: true,
              displayName: true,
              createdAt: true,
              whitelistState: true,
              status: true,
              _count: { select: { characters: true, submissions: true } },
              gameIdentities: {
                where: { unlinkedAt: null, kind: 'FIVEM' },
                select: { label: true },
                take: 1,
              },
            },
          },
        },
      });
      if (account === null) return null;

      const { user } = account;
      return {
        publicId: user.publicId,
        displayName: user.displayName,
        whitelistState: user.whitelistState,
        accountStatus: user.status,
        fivemLinked: user.gameIdentities.length > 0,
        cfxUsername: user.gameIdentities[0]?.label ?? null,
        characters: user._count.characters,
        applications: user._count.submissions,
        joinedAt: user.createdAt.toISOString(),
      };
    },

    async 'players.lookup'({ actorDiscordId, reference }) {
      requirePermission(await actorFromDiscord(db, actorDiscordId), 'players.view');
      const user = await findUserByReference(db, reference);
      if (user === null) return null;
      return {
        publicId: user.publicId,
        displayName: user.displayName,
        whitelistState: user.whitelistState,
        accountStatus: user.status,
      };
    },

    async 'whitelist.status'({ actorDiscordId }) {
      const account = await db.discordAccount.findUnique({
        where: { discordId: actorDiscordId },
        select: {
          user: {
            select: {
              id: true,
              whitelistState: true,
              whitelist: { select: { reason: true } },
            },
          },
        },
      });
      if (account === null) {
        return {
          hasAccount: false,
          state: null,
          reason: null,
          fivemLinked: false,
          latestApplication: null,
        };
      }

      const { user } = account;
      const [cfxIdentity, latest] = await Promise.all([
        db.gameIdentity.findFirst({
          where: { userId: user.id, unlinkedAt: null, kind: 'FIVEM' },
          select: { id: true },
        }),
        db.applicationSubmission.findFirst({
          where: { applicantId: user.id, template: { grantsWhitelist: true } },
          orderBy: { createdAt: 'desc' },
          select: { publicId: true, status: true },
        }),
      ]);

      return {
        hasAccount: true,
        state: user.whitelistState,
        reason: user.whitelist?.reason ?? null,
        fivemLinked: cfxIdentity !== null,
        latestApplication: latest === null ? null : statusView(latest),
      };
    },

    async 'applications.own'({ actorDiscordId, reference }) {
      const actor = await actorFromDiscord(db, actorDiscordId);
      requireAccount(actor);
      const submission = await getOwnApplication(db, actor, reference);
      if (submission === null) return null;
      return {
        reference: submission.publicId,
        templateName: submission.template.name,
        status: submission.status,
        statusLabel: statusLabels[submission.status],
      };
    },

    async 'applications.queue'({ actorDiscordId }) {
      const actor = await actorFromDiscord(db, actorDiscordId);
      const { items, total } = await listReviewQueue(db, actor, { take: 10 });
      return {
        total,
        items: items.map((submission) => ({
          reference: submission.publicId,
          applicant: submission.applicant.displayName ?? submission.applicant.publicId,
          templateName: submission.template.name,
          submittedAt: submission.submittedAt?.toISOString() ?? null,
        })),
      };
    },

    async 'applications.refreshCard'({ actorDiscordId, reference }) {
      requirePermission(await actorFromDiscord(db, actorDiscordId), 'applications.view');
      const submission = await findSubmission(reference);
      // `discord.review.update` posts the card when none exists and edits it
      // otherwise. `discord.review.post` would be collapsed by its BullMQ job id
      // once the first card was delivered, so a later refresh would be dropped.
      await enqueueDurable('discord.review.update', { submissionId: submission.id });
      return { queued: true };
    },

    async 'applications.authorize'({ actorDiscordId, action }) {
      const actor = await actorFromDiscord(db, actorDiscordId);
      return { allowed: can(actor, REVIEW_PERMISSIONS[action]) };
    },

    async 'applications.decide'(input) {
      const actor = await actorFromDiscord(db, input.actorDiscordId);
      const { reference } = input;

      switch (input.action) {
        case 'claim': {
          const submission = await claimApplication(db, actor, reference);
          // A re-claim of an application already under review changes only
          // the assignee, which the shared service does not re-render.
          await enqueueDurable('discord.review.update', { submissionId: submission.id });
          return statusView(submission);
        }
        case 'approve':
          return statusView(await approveApplication(db, actor, { reference }));
        case 'reject':
          return statusView(
            await rejectApplication(db, actor, {
              reference,
              publicNote: input.publicNote,
              staffNote: input.staffNote,
            }),
          );
        case 'changes':
          return statusView(
            await requestChanges(db, actor, {
              reference,
              publicNote: input.publicNote,
              staffNote: input.staffNote,
            }),
          );
        case 'interview':
          return statusView(
            await requestInterview(db, actor, {
              reference,
              publicNote: input.publicNote.length > 0 ? input.publicNote : null,
              staffNote: input.staffNote.length > 0 ? input.staffNote : null,
            }),
          );
      }
    },

    async 'link.status'({ actorDiscordId }) {
      const account = await db.discordAccount.findUnique({
        where: { discordId: actorDiscordId },
        select: { userId: true },
      });
      if (account === null) {
        return {
          hasAccount: false,
          linked: false,
          cfxUsername: null,
          linkedAt: null,
          verifiedOnWebsite: false,
        };
      }
      const connection = await cfxConnection(db, account.userId);
      return {
        hasAccount: true,
        linked: connection.linked,
        cfxUsername: connection.username,
        linkedAt: connection.linkedAt?.toISOString() ?? null,
        verifiedOnWebsite: connection.verifiedOnWebsite,
      };
    },

    async 'roles.sync'({ actorDiscordId, targetDiscordId }) {
      const target = targetDiscordId ?? actorDiscordId;
      const self = target === actorDiscordId;
      const actor = await actorFromDiscord(db, actorDiscordId);
      if (self) requireAccount(actor);
      else requirePermission(actor, 'discord.manage');

      const account = await db.discordAccount.findUnique({
        where: { discordId: target },
        select: { user: { select: { id: true, publicId: true } } },
      });
      if (account === null) throw new NotFoundError('DiscordAccount', target);

      const reason = self ? 'discord.self_resync' : 'discord.staff_resync';
      await transaction(db, async (tx) => {
        await enqueueDurable('discord.role.sync', { userId: account.user.id, reason }, { db: tx });
        await emitIntegrationEvent(tx, {
          type: 'ROLE_SYNC_REQUESTED',
          payload: { playerPublicId: account.user.publicId, reason },
          idempotencyKey: `role_sync.requested:${account.user.id}:${String(Date.now())}`,
          source: actor.source,
        });
      });
      return { queued: true, playerPublicId: account.user.publicId };
    },

    async 'tickets.closeOwn'({ actorDiscordId, ticketPublicId }) {
      const settings = await loadSupportSettings(db);
      if (!settings.allowDiscordClose) {
        throw new ConflictError(
          'Ticket close from Discord is disabled',
          'Ticket closing from Discord is disabled. Use the Xenon player portal.',
        );
      }
      const actor = await actorFromDiscord(db, actorDiscordId);
      const ticket = await closeOwnTicket(db, actor, ticketPublicId);
      return { publicId: ticket.publicId };
    },
  };
}
