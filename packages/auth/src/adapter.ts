import { PrismaAdapter } from '@auth/prisma-adapter';

import { allocatePublicId, type PrismaClient } from '@xenon/database';

import type { Adapter, AdapterUser } from 'next-auth/adapters';

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
      const publicId = await allocatePublicId(prisma, 'user');

      const user = await prisma.user.create({
        data: {
          publicId,
          email: data.email === '' ? null : data.email,
          emailVerified: data.emailVerified,
          displayName: data.name ?? null,
          avatarUrl: data.image ?? null,
          onboardingStep: 'DISCORD_CONNECTED',
          lastSeenAt: new Date(),
          roles: { create: [{ role: { connect: { key: 'member' } } }] },
        },
      });

      // Auth.js insists on a non-null `email` in its own type even though the
      // column is nullable here; Discord always supplies one for an account
      // that completed OAuth, and the empty string is the honest fallback.
      return {
        id: user.id,
        email: user.email ?? '',
        emailVerified: user.emailVerified,
        name: user.displayName,
        image: user.avatarUrl,
      };
    },

    async getUser(id): Promise<AdapterUser | null> {
      const user = await prisma.user.findUnique({ where: { id } });
      if (user === null) return null;
      // A soft-deleted account must never resolve to a live session.
      if (user.deletedAt !== null) return null;

      return {
        id: user.id,
        email: user.email ?? '',
        emailVerified: user.emailVerified,
        name: user.displayName,
        image: user.avatarUrl,
      };
    },
  };
}
