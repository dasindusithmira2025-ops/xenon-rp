import { ConflictError, NotFoundError, normalisePublicId } from '@xenon/core';
import {
  allocatePublicId,
  type Db,
  type OnboardingStep,
  type Prisma,
  type User,
  transaction,
} from '@xenon/database';
import { emitIntegrationEvent } from '@xenon/jobs';
import { type Actor, requirePermission, systemActor } from '@xenon/permissions';
import type { ProfileInput } from '@xenon/validation';

import { recordAudit } from './audit';
import { eventDiscordId, eventText } from './integration-events';

/**
 * Identity.
 *
 * The Xenon `User` is the account. A Discord account is a credential attached
 * to it and a projection of an external system, never the identity itself -
 * which is why a user who leaves the guild, changes username or reinstalls
 * Discord keeps the same XN identifier, the same applications and the same
 * history.
 */

export interface DiscordProfile {
  readonly discordId: string;
  readonly username: string;
  readonly globalName?: string | null;
  readonly discriminator?: string | null;
  readonly avatar?: string | null;
  readonly email?: string | null;
  readonly locale?: string | null;
}

/**
 * Find or create the account behind a Discord sign-in.
 *
 * Matching is on the snowflake alone. Usernames change and are re-usable, so
 * treating one as an identity would eventually hand a stranger someone else's
 * whitelist.
 */
export async function ensureUserFromDiscord(db: Db, profile: DiscordProfile): Promise<User> {
  try {
    return await transaction(db, async (tx) => {
      const existing = await tx.discordAccount.findUnique({
        where: { discordId: profile.discordId },
        select: { userId: true },
      });

      if (existing !== null) {
        await tx.discordAccount.update({
          where: { discordId: profile.discordId },
          data: profileFields(profile),
        });

        return tx.user.update({
          where: { id: existing.userId },
          data: { lastSeenAt: new Date() },
        });
      }

      const publicId = await allocatePublicId(tx, 'user');

      const created = await tx.user.create({
        data: {
          publicId,
          displayName: profile.globalName ?? profile.username,
          // Email is optional contact information, never an identity key.
          email: profile.email ?? null,
          avatarUrl: avatarUrlFor(profile),
          lastSeenAt: new Date(),
          onboardingStep: 'DISCORD_CONNECTED',
          discordAccount: { create: { discordId: profile.discordId, ...profileFields(profile) } },
          // Every account holds the baseline role from its first committed row.
          roles: { create: [{ role: { connect: { key: 'member' } } }] },
        },
      });

      const discordAccount = await tx.discordAccount.findUniqueOrThrow({
        where: { discordId: profile.discordId },
        select: { id: true },
      });
      await recordAudit(tx, systemActor, {
        action: 'discord.account_linked',
        entityType: 'discord_account',
        entityId: discordAccount.id,
        entityLabel: created.publicId,
        after: { discordUserId: profile.discordId },
      });
      return created;
    });
  } catch (error) {
    // Two OAuth callbacks can both observe an absent snowflake. The unique
    // constraint chooses one transaction; the loser resolves the winner's
    // account instead of creating a second Xenon identity or failing login.
    if (!isUniqueViolation(error)) throw error;

    const existing = await db.discordAccount.findUnique({
      where: { discordId: profile.discordId },
      select: { userId: true },
    });
    if (existing === null) throw error;

    await db.discordAccount.update({
      where: { discordId: profile.discordId },
      data: profileFields(profile),
    });
    return db.user.update({
      where: { id: existing.userId },
      data: { lastSeenAt: new Date() },
    });
  }
}

/** Raised when an OAuth callback would move a Discord snowflake between users. */
export class DiscordIdentityConflictError extends ConflictError {
  constructor() {
    super(
      'Discord identity ownership conflict',
      'This Discord account is already connected to another Xenon account.',
    );
  }
}

// Auth.js 0.41 creates a temporary UUID for a new OAuth profile and invokes
// its signIn callback before calling the adapter's createUser method. The
// callback passes that UUID here; it becomes the Xenon user id for the first
// sign-in, while later callbacks resolve the persisted account through the
// adapter.
const AUTHJS_PROVISIONAL_USER_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Refresh the safe profile projection and verify both sides of the one-to-one
 * link. This never merges users or reassigns an existing Discord identity.
 */
export async function syncDiscordIdentity(
  db: Db,
  userId: string,
  profile: DiscordProfile,
): Promise<void> {
  let linkCreated = false;

  await transaction(db, async (tx) => {
    const [byDiscordId, byUserId, user] = await Promise.all([
      tx.discordAccount.findUnique({
        where: { discordId: profile.discordId },
        select: { id: true, userId: true },
      }),
      tx.discordAccount.findUnique({
        where: { userId },
        select: { discordId: true },
      }),
      tx.user.findUnique({
        where: { id: userId },
        select: { publicId: true, deletedAt: true },
      }),
    ]);

    if (user === null) {
      // A first OAuth callback reaches this service before Auth.js calls
      // adapter.createUser. Persist its provisional UUID as the canonical
      // Xenon id so the callback and the subsequent session/queue writes all
      // refer to the same account. Existing Discord ownership still wins:
      // never move an identity to an unverified or missing user.
      if (!AUTHJS_PROVISIONAL_USER_ID.test(userId) || byDiscordId !== null || byUserId !== null) {
        throw new DiscordIdentityConflictError();
      }

      const created = await tx.user.create({
        data: {
          id: userId,
          publicId: await allocatePublicId(tx, 'user'),
          displayName: profile.globalName ?? profile.username,
          email: profile.email ?? null,
          avatarUrl: avatarUrlFor(profile),
          lastSeenAt: new Date(),
          onboardingStep: 'DISCORD_CONNECTED',
          discordAccount: {
            create: { discordId: profile.discordId, ...profileFields(profile) },
          },
          roles: { create: [{ role: { connect: { key: 'member' } } }] },
        },
      });
      const account = await tx.discordAccount.findUniqueOrThrow({
        where: { discordId: profile.discordId },
        select: { id: true },
      });
      await recordAudit(tx, systemActor, {
        action: 'discord.account_linked',
        entityType: 'discord_account',
        entityId: account.id,
        entityLabel: created.publicId,
        after: { discordUserId: profile.discordId },
      });
      linkCreated = true;
      return;
    }

    if (
      user.deletedAt !== null ||
      (byDiscordId !== null && byDiscordId.userId !== userId) ||
      (byUserId !== null && byUserId.discordId !== profile.discordId)
    ) {
      throw new DiscordIdentityConflictError();
    }

    const fields = profileFields(profile);
    const account =
      byDiscordId === null
        ? await tx.discordAccount.create({
            data: { userId, discordId: profile.discordId, ...fields },
          })
        : await tx.discordAccount.update({
            where: { discordId: profile.discordId },
            data: fields,
          });
    linkCreated = byDiscordId === null;

    const changed = await tx.user.updateMany({
      where: { id: userId, deletedAt: null },
      data: { lastSeenAt: new Date(), avatarUrl: avatarUrlFor(profile) },
    });
    if (changed.count !== 1) throw new DiscordIdentityConflictError();

    if (linkCreated) {
      const actor: Actor = {
        userId,
        publicId: user.publicId,
        label: user.publicId,
        source: 'DISCORD',
        permissions: new Set(),
        roleKeys: new Set(),
      };
      await recordAudit(tx, actor, {
        action: 'discord.account_linked',
        entityType: 'discord_account',
        entityId: account.id,
        entityLabel: user.publicId,
        after: { discordUserId: profile.discordId },
      });
    }
  });

  await refreshOnboardingStep(db, userId);
}

function profileFields(profile: DiscordProfile) {
  return {
    username: profile.username,
    globalName: profile.globalName ?? null,
    discriminator: profile.discriminator ?? null,
    avatar: profile.avatar ?? null,
    locale: profile.locale ?? null,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'P2002';
}

function avatarUrlFor(profile: DiscordProfile): string | null {
  if (!profile.avatar) return null;
  const extension = profile.avatar.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${profile.discordId}/${profile.avatar}.${extension}?size=256`;
}

/**
 * The ordered onboarding ladder. Index in this array is the progress.
 *
 * The verified Cfx.re link comes straight after Discord: it is a one-click
 * website step, and staff reviewing a whitelist application want to know which
 * game account it is for.
 */
export const onboardingOrder: readonly OnboardingStep[] = [
  'DISCORD_CONNECTED',
  'GUILD_MEMBERSHIP',
  'FIVEM_LINK',
  'PROFILE',
  'RULES',
  'WHITELIST',
  'COMPLETE',
];

export interface OnboardingState {
  readonly step: OnboardingStep;
  readonly completed: readonly OnboardingStep[];
  readonly next: OnboardingStep | null;
  readonly percentComplete: number;
  readonly checks: {
    readonly discordLinked: boolean;
    readonly guildMember: boolean;
    readonly profileComplete: boolean;
    readonly rulesAccepted: boolean;
    readonly fivemLinked: boolean;
    readonly whitelisted: boolean;
  };
}

/**
 * Derive onboarding state from facts, not from a stored cursor.
 *
 * `User.onboardingStep` is a cache for cheap reads; this recomputes from the
 * underlying rows so a player who connects Cfx.re in another tab, or loses
 * guild membership, sees the correct next step on the next render.
 *
 * `fivemLinked` means a verified Cfx.re account (an active FIVEM identity).
 * Identifiers left over from the retired in-game code flow do not count.
 */
export async function onboardingState(db: Db, userId: string): Promise<OnboardingState> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      displayName: true,
      whitelistState: true,
      discordAccount: { select: { isGuildMember: true } },
      gameIdentities: {
        where: { kind: 'FIVEM', unlinkedAt: null },
        select: { id: true },
        take: 1,
      },
      ruleAcceptances: {
        select: { ruleSet: { select: { isCurrent: true } } },
      },
    },
  });

  if (user === null) throw new NotFoundError('User', userId);

  const checks = {
    discordLinked: user.discordAccount !== null,
    guildMember: user.discordAccount?.isGuildMember ?? false,
    profileComplete: (user.displayName ?? '').length > 0,
    rulesAccepted: user.ruleAcceptances.some((acceptance) => acceptance.ruleSet.isCurrent),
    fivemLinked: user.gameIdentities.length > 0,
    whitelisted: user.whitelistState === 'APPROVED',
  };

  const completed: OnboardingStep[] = [];
  if (checks.discordLinked) completed.push('DISCORD_CONNECTED');
  if (checks.guildMember) completed.push('GUILD_MEMBERSHIP');
  if (checks.fivemLinked) completed.push('FIVEM_LINK');
  if (checks.profileComplete) completed.push('PROFILE');
  if (checks.rulesAccepted) completed.push('RULES');
  if (checks.whitelisted) completed.push('WHITELIST');
  if (completed.length === onboardingOrder.length - 1) completed.push('COMPLETE');

  // The current step is the first unmet requirement rather than the furthest
  // one reached, so losing guild membership walks the user back to fixing that.
  const next = onboardingOrder.find((step) => !completed.includes(step)) ?? null;
  const step = next ?? 'COMPLETE';

  return {
    step,
    completed,
    next: next === 'COMPLETE' ? null : next,
    percentComplete: Math.round((completed.length / onboardingOrder.length) * 100),
    checks,
  };
}

/** Refresh the cached onboarding cursor. Cheap; called after relevant changes. */
export async function refreshOnboardingStep(db: Db, userId: string): Promise<OnboardingStep> {
  const state = await onboardingState(db, userId);
  await db.user.update({ where: { id: userId }, data: { onboardingStep: state.step } });
  return state.step;
}

/** Update the player's own profile. */
export async function updateProfile(
  db: Db,
  actor: Actor,
  userId: string,
  input: ProfileInput,
): Promise<User> {
  const before = await db.user.findUnique({
    where: { id: userId },
    select: { displayName: true, pronouns: true, timezone: true, bio: true },
  });
  if (before === null) throw new NotFoundError('User', userId);

  const user = await db.user.update({
    where: { id: userId },
    data: {
      displayName: input.displayName,
      pronouns: input.pronouns ?? null,
      timezone: input.timezone ?? null,
      bio: input.bio ?? null,
    },
  });

  await recordAudit(db, actor, {
    action: 'user.profile_updated',
    entityType: 'user',
    entityId: userId,
    entityLabel: user.publicId,
    before,
    after: {
      displayName: user.displayName,
      pronouns: user.pronouns,
      timezone: user.timezone,
      bio: user.bio,
    },
  });

  await refreshOnboardingStep(db, userId);
  return user;
}

/**
 * Resolve a user from whatever staff typed: an XN id, a Discord snowflake, a
 * display name or a Discord username.
 *
 * Bare numbers are read as Discord snowflakes rather than as XN ids, because a
 * pasted Discord ID is by far the more common input and `normalisePublicId`
 * deliberately refuses a bare number without context.
 */
export async function findUserByReference(db: Db, reference: string): Promise<User | null> {
  const trimmed = reference.trim();
  if (trimmed.length === 0) return null;

  const asPublicId = normalisePublicId(trimmed);
  if (asPublicId !== null) {
    const byPublicId = await db.user.findUnique({ where: { publicId: asPublicId } });
    if (byPublicId !== null) return byPublicId;
  }

  if (/^\d{17,20}$/.test(trimmed)) {
    const account = await db.discordAccount.findUnique({
      where: { discordId: trimmed },
      select: { user: true },
    });
    if (account !== null) return account.user;
  }

  return db.user.findFirst({
    where: {
      deletedAt: null,
      OR: [
        { displayName: { equals: trimmed, mode: 'insensitive' } },
        { discordAccount: { username: { equals: trimmed, mode: 'insensitive' } } },
      ],
    },
  });
}

export interface UserSearchQuery {
  readonly search?: string;
  readonly whitelistState?: Prisma.UserWhereInput['whitelistState'];
  readonly status?: Prisma.UserWhereInput['status'];
  readonly roleKey?: string;
  readonly skip?: number;
  readonly take?: number;
}

/** Staff-facing player directory. */
export async function searchUsers(db: Db, query: UserSearchQuery = {}) {
  const take = Math.min(query.take ?? 25, 100);
  const search = query.search?.trim();

  const where: Prisma.UserWhereInput = {
    deletedAt: null,
    ...(query.whitelistState === undefined ? {} : { whitelistState: query.whitelistState }),
    ...(query.status === undefined ? {} : { status: query.status }),
    ...(query.roleKey === undefined ? {} : { roles: { some: { role: { key: query.roleKey } } } }),
    ...(search === undefined || search.length === 0
      ? {}
      : {
          OR: [
            { publicId: { contains: search.toUpperCase() } },
            { displayName: { contains: search, mode: 'insensitive' } },
            { discordAccount: { username: { contains: search, mode: 'insensitive' } } },
            { discordAccount: { discordId: search } },
          ],
        }),
  };

  const [items, total] = await Promise.all([
    db.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: query.skip ?? 0,
      take,
      include: {
        discordAccount: {
          select: {
            username: true,
            discordId: true,
            isGuildMember: true,
            guildMembershipState: true,
          },
        },
        roles: { include: { role: { select: { key: true, name: true, colour: true } } } },
        _count: { select: { characters: true, submissions: true } },
      },
    }),
    db.user.count({ where }),
  ]);

  return { items, total };
}

/**
 * Suspend or ban an account. Roles are kept so the sanction is reversible.
 *
 * The capability is checked here rather than at the call site, so a Discord
 * command or a worker that reaches this function cannot arrive without one.
 *
 * A move into SUSPENDED or BANNED also opens a platform `ModerationCase` and
 * records PLAYER_SUSPENDED / PLAYER_BANNED, all in the same transaction as the
 * status itself, so Xenon Link hears about exactly the sanctions that exist.
 */
export async function setUserStatus(
  db: Db,
  actor: Actor,
  userId: string,
  status: 'ACTIVE' | 'SUSPENDED' | 'BANNED' | 'DEACTIVATED',
  reason: string | null,
): Promise<User> {
  requirePermission(actor, 'players.ban');

  return transaction(db, async (tx) => {
    const before = await tx.user.findUnique({
      where: { id: userId },
      select: { status: true, discordAccount: { select: { discordId: true } } },
    });
    if (before === null) throw new NotFoundError('User', userId);

    const user = await tx.user.update({ where: { id: userId }, data: { status } });

    await recordAudit(tx, actor, {
      action: `user.status_changed`,
      entityType: 'user',
      entityId: userId,
      entityLabel: user.publicId,
      before: { status: before.status },
      after: { status },
      metadata: reason === null ? undefined : { reason },
    });

    // Killing the sessions is what makes a ban take effect now rather than at the
    // next session expiry.
    if (status !== 'ACTIVE') {
      await tx.session.deleteMany({ where: { userId } });
    }

    if ((status === 'SUSPENDED' || status === 'BANNED') && before.status !== status) {
      const caseReason = eventText(reason, 500, 'No reason recorded');
      const moderationCase = await tx.moderationCase.create({
        data: {
          userId,
          scope: 'PLATFORM',
          kind: status === 'BANNED' ? 'BAN' : 'SUSPEND',
          source: actor.source,
          reason: caseReason,
          actorId: actor.userId,
        },
        select: { id: true },
      });
      const discordId = eventDiscordId(before.discordAccount?.discordId);
      const idempotencyKey = `moderation_case:${moderationCase.id}`;

      if (status === 'BANNED') {
        await emitIntegrationEvent(tx, {
          type: 'PLAYER_BANNED',
          payload: {
            playerPublicId: user.publicId,
            discordId,
            scope: 'PLATFORM',
            reason: caseReason,
            expiresAt: null,
            caseId: moderationCase.id,
          },
          idempotencyKey,
          source: actor.source,
        });
      } else {
        await emitIntegrationEvent(tx, {
          type: 'PLAYER_SUSPENDED',
          payload: { playerPublicId: user.publicId, discordId, until: null, reason: caseReason },
          idempotencyKey,
          source: actor.source,
        });
      }
    }

    return user;
  });
}
