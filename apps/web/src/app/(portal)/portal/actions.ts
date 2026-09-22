'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { withdrawApplication } from '@xenon/applications';
import { serverEnv } from '@xenon/config/server';
import { IntegrationError } from '@xenon/core';
import { prisma } from '@xenon/database';
import {
  acceptRules,
  createCharacter,
  currentRuleSet,
  recordAudit,
  replyToTicket,
  retireCharacter,
  updateCharacter,
  updateProfile,
  withdrawAppeal,
} from '@xenon/domain';
import { issueLinkCode, unlinkIdentity } from '@xenon/fivem';
import { enqueue, enforceRateLimit } from '@xenon/jobs';
import { markAllNotificationsRead, markNotificationRead } from '@xenon/notifications';
import { characterInput, cuid, profileInput, ticketReplyInput } from '@xenon/validation';

import { type ActionResult, parseInput, runAction } from '~/server/action';
import { currentActor, requireSignedIn, requireUserId } from '~/server/context';

/**
 * Player portal actions.
 *
 * Thin transports over the shared services. Nothing here decides policy: the
 * services own authorization, rate limiting, audit and notification, so the
 * identical operation triggered from Discord behaves the same way.
 */

async function clientIp(): Promise<string | null> {
  const store = await headers();
  return store.get('x-forwarded-for')?.split(',')[0]?.trim() ?? store.get('x-real-ip');
}

// --- Profile and onboarding --------------------------------------------------

export async function updateProfileAction(raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const input = parseInput(profileInput, raw);
    const actor = await requireSignedIn();

    await updateProfile(prisma, actor, actor.userId ?? '', input);
    revalidatePath('/portal');
    revalidatePath('/portal/account');
  });
}

export async function acceptRulesAction(): Promise<ActionResult<{ version: number }>> {
  return runAction(async () => {
    const actor = await requireSignedIn();
    const ruleSet = await currentRuleSet(prisma);

    if (ruleSet === null) {
      // Not an error the player can act on, so it is reported as a conflict
      // rather than silently succeeding and marking them as having accepted
      // something that does not exist.
      throw new Error('No ruleset has been published yet.');
    }

    const store = await headers();
    await acceptRules(prisma, actor, actor.userId ?? '', ruleSet.id, {
      ip: await clientIp(),
      userAgent: store.get('user-agent'),
    });

    revalidatePath('/portal');
    revalidatePath('/rules');
    return { version: ruleSet.version };
  });
}

// --- FiveM linking -----------------------------------------------------------

export async function issueLinkCodeAction(): Promise<
  ActionResult<{ code: string; expiresAt: string }>
> {
  return runAction(async () => {
    const actor = await requireSignedIn();
    const issued = await issueLinkCode(prisma, actor, { ip: await clientIp() });

    revalidatePath('/portal/account');
    // The plaintext code crosses the wire exactly once, to the person who asked
    // for it. Only its hash is stored.
    return { code: issued.code, expiresAt: issued.expiresAt.toISOString() };
  });
}

export async function unlinkIdentityAction(identityId: string): Promise<ActionResult> {
  return runAction(async () => {
    const id = parseInput(cuid, identityId);
    const actor = await requireSignedIn();

    await unlinkIdentity(prisma, actor, id);
    revalidatePath('/portal/account');
    revalidatePath('/portal');
  });
}

/** Ask the persistent bot to refresh this account's current guild membership. */
export async function resyncDiscordMembershipAction(): Promise<
  ActionResult<{ requestedAt: string }>
> {
  return runAction(async () => {
    const actor = await requireSignedIn();
    const userId = actor.userId ?? '';
    await enforceRateLimit('discordMembershipResync', userId);

    if (serverEnv.DISCORD_MODE !== 'enabled') {
      throw new IntegrationError('discord', 'Discord is disabled in this environment', {
        retryable: false,
      });
    }

    const account = await prisma.discordAccount.findUnique({
      where: { userId },
      select: { id: true, discordId: true },
    });
    if (account === null) {
      throw new IntegrationError('discord', 'No Discord account is linked', { retryable: false });
    }

    const requestedAt = new Date();
    await enqueue('discord.membership.sync', { userId, reason: 'portal.manual_resync' });
    await recordAudit(prisma, actor, {
      action: 'discord.membership_resync_requested',
      entityType: 'discord_account',
      entityId: account.id,
      metadata: { discordUserId: account.discordId },
    });

    revalidatePath('/portal/account');
    return { requestedAt: requestedAt.toISOString() };
  });
}

// --- Characters --------------------------------------------------------------

export async function createCharacterAction(
  raw: unknown,
): Promise<ActionResult<{ publicId: string }>> {
  return runAction(async () => {
    const input = parseInput(characterInput, raw);
    const actor = await requireSignedIn();

    const character = await createCharacter(prisma, actor, actor.userId ?? '', input);
    revalidatePath('/portal/characters');
    return { publicId: character.publicId };
  });
}

export async function updateCharacterAction(
  characterId: string,
  raw: unknown,
): Promise<ActionResult> {
  return runAction(async () => {
    const id = parseInput(cuid, characterId);
    const input = parseInput(characterInput, raw);
    const actor = await requireSignedIn();

    await updateCharacter(prisma, actor, id, input);
    revalidatePath('/portal/characters');
  });
}

export async function retireCharacterAction(characterId: string): Promise<ActionResult> {
  return runAction(async () => {
    const id = parseInput(cuid, characterId);
    const actor = await requireSignedIn();

    await retireCharacter(prisma, actor, id);
    revalidatePath('/portal/characters');
  });
}

// --- Applications ------------------------------------------------------------

export async function withdrawApplicationAction(submissionId: string): Promise<ActionResult> {
  return runAction(async () => {
    const id = parseInput(cuid, submissionId);
    const actor = await requireSignedIn();

    await withdrawApplication(prisma, actor, id);
    revalidatePath('/portal/applications');
  });
}

// --- Tickets -----------------------------------------------------------------

export async function replyToTicketAction(raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const input = parseInput(ticketReplyInput, raw);
    const actor = await requireSignedIn();

    await replyToTicket(prisma, actor, input);
    revalidatePath('/portal/tickets');
  });
}

// --- Appeals -----------------------------------------------------------------

export async function withdrawAppealAction(appealId: string): Promise<ActionResult> {
  return runAction(async () => {
    const id = parseInput(cuid, appealId);
    const actor = await requireSignedIn();

    await withdrawAppeal(prisma, actor, id);
    revalidatePath('/portal/appeals');
  });
}

// --- Notifications -----------------------------------------------------------

export async function markNotificationReadAction(notificationId: string): Promise<ActionResult> {
  return runAction(async () => {
    const id = parseInput(cuid, notificationId);
    const userId = await requireUserId();

    // Scoped by user inside the service, so knowing an id is not enough to
    // touch somebody else's notification.
    await markNotificationRead(prisma, userId, id);
    revalidatePath('/portal/notifications');
  });
}

export async function markAllNotificationsReadAction(): Promise<ActionResult<{ count: number }>> {
  return runAction(async () => {
    const userId = await requireUserId();
    const count = await markAllNotificationsRead(prisma, userId);

    revalidatePath('/portal/notifications');
    revalidatePath('/portal');
    return { count };
  });
}

/** Used by the header badge poll. Cheap, indexed count. */
export async function unreadCountAction(): Promise<ActionResult<{ unread: number }>> {
  return runAction(async () => {
    const actor = await currentActor();
    if (actor.userId === null) return { unread: 0 };

    const unread = await prisma.notification.count({
      where: { userId: actor.userId, webReadAt: null },
    });
    return { unread };
  });
}
