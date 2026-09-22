import { PrismaAdapter } from '@auth/prisma-adapter';

import { type PrismaClient, type User } from '@xenon/database';
import { ensureUserFromDiscord } from '@xenon/domain';

import type { Adapter, AdapterAccount, AdapterUser } from 'next-auth/adapters';

/**
 * Auth.js adapter, wrapped.
 *
 * The stock Prisma adapter writes a `User` row with only the OAuth profile
 * fields, which cannot work here: `publicId` is a required unique column, and
 * every account is expected to hold the baseline `member` role from the moment
 * it exists. Overriding `createUser` is the smallest place to put that, and it
 * keeps account creation atomic rather than leaving a window where a user has
 * no identifier and no role.
 */
export function xenonAdapter(prisma: PrismaClient): Adapter {
  const base = PrismaAdapter(prisma);

  return {
    ...base,

    async createUser(data): Promise<AdapterUser> {
      // Auth.js passes the mapped provider profile (including its stable id) to
      // createUser. Resolve it through Xenon's identity service so concurrent
      // first callbacks converge on the same User + DiscordAccount transaction.
      const user = await ensureUserFromDiscord(prisma, {
        discordId: data.id,
        username: data.name ?? data.id,
        globalName: data.name,
        avatar: data.image?.split('/').at(-1)?.split('.')[0] ?? null,
        email: data.email || null,
      });

      return toAdapterUser(user);
    },

    async getUser(id): Promise<AdapterUser | null> {
      const user = await prisma.user.findUnique({ where: { id } });
      if (user === null) return null;
      // A soft-deleted account must never resolve to a live session.
      if (user.deletedAt !== null) return null;

      return toAdapterUser(user);
    },

    async getUserByAccount(key): Promise<AdapterUser | null> {
      const linked = await base.getUserByAccount?.(key);
      if (linked !== null && linked !== undefined) {
        const user = await prisma.user.findUnique({ where: { id: linked.id } });
        return user?.deletedAt === null ? toAdapterUser(user) : null;
      }

      // Older Xenon rows may have a DiscordAccount but no Auth.js Account row.
      // The snowflake is still the canonical external identity, so keep that
      // player on the same Xenon User instead of creating a second account.
      if (key.provider !== 'discord') return null;
      const existing = await prisma.discordAccount.findUnique({
        where: { discordId: key.providerAccountId },
        include: { user: true },
      });
      return existing?.user.deletedAt === null ? toAdapterUser(existing.user) : null;
    },

    async linkAccount(account: AdapterAccount): Promise<AdapterAccount> {
      if (account.provider !== 'discord') {
        throw new Error('Xenon only allows Discord identities.');
      }

      const identity = await prisma.discordAccount.findUnique({
        where: { discordId: account.providerAccountId },
        select: { userId: true },
      });
      if (identity?.userId !== account.userId) {
        throw new Error('Discord account ownership does not match the Xenon account.');
      }

      // OAuth access, refresh and ID tokens are not needed after identify. Keep
      // the Auth.js account pointer for provider lookup, but persist no tokens.
      const stored = await prisma.account.upsert({
        where: {
          provider_providerAccountId: {
            provider: account.provider,
            providerAccountId: account.providerAccountId,
          },
        },
        create: {
          userId: account.userId,
          type: account.type,
          provider: account.provider,
          providerAccountId: account.providerAccountId,
          refresh_token: null,
          access_token: null,
          expires_at: null,
          token_type: null,
          scope: null,
          id_token: null,
          session_state: null,
        },
        update: {},
      });

      if (stored.userId !== account.userId) {
        throw new Error('Discord account is already linked to another Xenon account.');
      }

      return accountWithoutTokens(stored, account);
    },
  };
}

function toAdapterUser(user: User): AdapterUser {
  return {
    id: user.id,
    email: user.email ?? '',
    emailVerified: user.emailVerified,
    name: user.displayName,
    image: user.avatarUrl,
  };
}

function accountWithoutTokens(
  stored: { userId: string; type: string; provider: string; providerAccountId: string },
  source: AdapterAccount,
): AdapterAccount {
  return {
    ...source,
    userId: stored.userId,
    type: source.type,
    provider: source.provider,
    providerAccountId: source.providerAccountId,
    refresh_token: undefined,
    access_token: undefined,
    expires_at: undefined,
    token_type: undefined,
    scope: undefined,
    id_token: undefined,
    session_state: undefined,
  };
}
