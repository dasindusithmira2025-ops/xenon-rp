import { NotFoundError, normalisePublicId } from '@xenon/core';
import {
  allocatePublicId,
  type Db,
  type OnboardingStep,
  type Prisma,
  type User,
} from '@xenon/database';
import type { Actor } from '@xenon/permissions';
import type { ProfileInput } from '@xenon/validation';

import { recordAudit } from './audit';

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
  const existing = await db.discordAccount.findUnique({
    where: { discordId: profile.discordId },
    select: { userId: true },
  });

  if (existing !== null) {
    await db.discordAccount.update({
      where: { discordId: profile.discordId },
      data: {
        username: profile.username,
        globalName: profile.globalName ?? null,
        discriminator: profile.discriminator ?? null,
        avatar: profile.avatar ?? null,
        locale: profile.locale ?? null,
      },
    });

    return db.user.update({
      where: { id: existing.userId },
      data: { lastSeenAt: new Date() },
    });
  }

  const publicId = await allocatePublicId(db, 'user');

  return db.user.create({
    data: {
      publicId,
      displayName: profile.globalName ?? profile.username,
      // Discord's email is verified by Discord; it is stored for contact only
      // and is never a sign-in factor here.
      email: profile.email ?? null,
      avatarUrl: avatarUrlFor(profile),
      lastSeenAt: new Date(),
      onboardingStep: 'DISCORD_CONNECTED',
      discordAccount: {
        create: {
          discordId: profile.discordId,
          username: profile.username,
          globalName: profile.globalName ?? null,
          discriminator: profile.discriminator ?? null,
          avatar: profile.avatar ?? null,
          locale: profile.locale ?? null,
        },
      },
      // Every account holds the baseline role, so "signed in" and "has a role
      // row" never disagree.
      roles: {
        create: [{ role: { connect: { key: 'member' } } }],
      },
    },
  });
}

function avatarUrlFor(profile: DiscordProfile): string | null {
  if (!profile.avatar) return null;
  const extension = profile.avatar.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${profile.discordId}/${profile.avatar}.${extension}?size=256`;
}

/** The ordered onboarding ladder. Index in this array is the progress. */
export const onboardingOrder: readonly OnboardingStep[] = [
  'DISCORD_CONNECTED',
  'GUILD_MEMBERSHIP',
  'PROFILE',
  'RULES',
  'FIVEM_LINK',
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
 * underlying rows so a user who links FiveM through the game - never touching
 * the portal - still sees the correct next step.
 */
export async function onboardingState(db: Db, userId: string): Promise<OnboardingState> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      displayName: true,
      whitelistState: true,
      discordAccount: { select: { isGuildMember: true } },
      gameIdentities: { where: { unlinkedAt: null }, select: { id: true }, take: 1 },
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
  if (checks.profileComplete) completed.push('PROFILE');
  if (checks.rulesAccepted) completed.push('RULES');
  if (checks.fivemLinked) completed.push('FIVEM_LINK');
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
        discordAccount: { select: { username: true, discordId: true, isGuildMember: true } },
        roles: { include: { role: { select: { key: true, name: true, colour: true } } } },
        _count: { select: { characters: true, submissions: true } },
      },
    }),
    db.user.count({ where }),
  ]);

  return { items, total };
}

/** Suspend or ban an account. Roles are kept so the sanction is reversible. */
export async function setUserStatus(
  db: Db,
  actor: Actor,
  userId: string,
  status: 'ACTIVE' | 'SUSPENDED' | 'BANNED' | 'DEACTIVATED',
  reason: string | null,
): Promise<User> {
  const before = await db.user.findUnique({ where: { id: userId }, select: { status: true } });
  if (before === null) throw new NotFoundError('User', userId);

  const user = await db.user.update({ where: { id: userId }, data: { status } });

  await recordAudit(db, actor, {
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
    await db.session.deleteMany({ where: { userId } });
  }

  return user;
}
