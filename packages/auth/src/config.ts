import Discord from 'next-auth/providers/discord';

import { serverEnv, discordCallbackUrl } from '@xenon/config/server';
import { prisma } from '@xenon/database';
import { DiscordIdentityConflictError, syncDiscordIdentity } from '@xenon/domain';
import { enqueueBestEffort } from '@xenon/jobs';
import { createLogger } from '@xenon/logger';

import { xenonAdapter } from './adapter';

import type { NextAuthConfig } from 'next-auth';

/**
 * Auth.js configuration.
 *
 * Discord is the only identity provider, and the `User` row it creates is the
 * account - the Discord snowflake is a credential attached to it, stored
 * separately in `DiscordAccount`. That separation is what lets a player change
 * their Discord username, leave the guild, or have their token revoked without
 * any of it touching their XN identifier, their applications or their
 * whitelist.
 *
 * Database sessions rather than JWTs. A JWT cannot be revoked before it
 * expires, and this platform needs "ban takes effect now" to be true - which it
 * is, because `setUserStatus` deletes the session rows.
 */

/** Player OAuth only needs the stable Discord snowflake and public profile. */
const DISCORD_SCOPES = ['identify'] as const;

function discordProviders() {
  if (serverEnv.DISCORD_MODE !== 'enabled') return [];

  const clientId = serverEnv.AUTH_DISCORD_ID;
  const clientSecret = serverEnv.AUTH_DISCORD_SECRET;
  if (clientId === undefined || clientSecret === undefined) {
    throw new Error('Discord sign-in is enabled but its OAuth credentials are missing.');
  }

  return [
    Discord({
      clientId,
      clientSecret,
      authorization: { params: { scope: DISCORD_SCOPES.join(' ') } },
      // Map Discord's shape to the adapter's expectations. Without this the
      // display name would be the legacy `username#1234` rather than the name
      // the person actually goes by.
      profile(raw) {
        const profile = raw as unknown as DiscordProfile;
        return {
          id: profile.id,
          name: profile.global_name ?? profile.username,
          email: null,
          image: avatarUrl(profile),
        };
      },
    }),
  ];
}

const logger = createLogger({
  service: 'auth',
  level: serverEnv.LOG_LEVEL,
  pretty: serverEnv.NODE_ENV !== 'production',
});

interface DiscordProfile {
  id: string;
  username: string;
  global_name?: string | null;
  discriminator?: string | null;
  avatar?: string | null;
  locale?: string | null;
}

function avatarUrl(profile: DiscordProfile): string | null {
  if (!profile.avatar) return null;
  const extension = profile.avatar.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.${extension}?size=256`;
}

export const authConfig: NextAuthConfig = {
  adapter: xenonAdapter(prisma),

  session: {
    strategy: 'database',
    maxAge: 60 * 60 * 24 * 30,
    // Refresh at most daily: a write on every request would make the session
    // table the busiest one in the database for no benefit.
    updateAge: 60 * 60 * 24,
  },

  // Production must opt in explicitly: trusting the Host header behind a proxy
  // that does not rewrite it lets an attacker steer the OAuth callback. In
  // development the host is always the dev server on localhost, and requiring
  // the flag there only produces an UntrustedHost error on a fresh clone.
  trustHost: serverEnv.AUTH_TRUST_HOST || serverEnv.NODE_ENV !== 'production',
  secret: serverEnv.AUTH_SECRET,

  pages: {
    signIn: '/signin',
    error: '/signin',
  },

  providers: discordProviders(),

  callbacks: {
    /**
     * Mirror the Discord profile into `DiscordAccount`.
     *
     * Runs on every sign-in, so a username or avatar change is picked up
     * without a separate sync. Returning false here would block the sign-in, so
     * a failure to mirror is logged and swallowed: stale profile data is a far
     * smaller problem than an account that cannot sign in.
     */
    async signIn({ user, account, profile }) {
      if (account?.provider !== 'discord' || profile === undefined) return true;

      const discord = profile as unknown as DiscordProfile;
      const xenonUserId = user.id;
      if (
        xenonUserId === undefined ||
        discord.id !== account.providerAccountId ||
        !/^\d{17,20}$/.test(discord.id)
      ) {
        logger.warn(
          { discordUserId: discord.id },
          'Discord callback identity did not match its authenticated account',
        );
        return false;
      }

      try {
        await syncDiscordIdentity(prisma, xenonUserId, {
          discordId: discord.id,
          username: discord.username,
          globalName: discord.global_name ?? null,
          discriminator: discord.discriminator ?? null,
          avatar: discord.avatar ?? null,
          locale: discord.locale ?? null,
        });

        await enqueueBestEffort('discord.membership.sync', {
          userId: xenonUserId,
          reason: 'oauth.signin',
        });
      } catch (error) {
        if (error instanceof DiscordIdentityConflictError) {
          logger.warn(
            { discordUserId: discord.id, xenonUserId },
            'Discord account is already linked to another Xenon identity',
          );
          return new URL(
            '/signin?error=DiscordAccountConflict',
            new URL(discordCallbackUrl()).origin,
          ).toString();
        }

        logger.error(
          { err: error, discordUserId: discord.id, xenonUserId },
          'Could not synchronize the Discord identity',
        );
        return new URL(
          '/signin?error=DiscordUnavailable',
          new URL(discordCallbackUrl()).origin,
        ).toString();
      }

      return true;
    },

    /**
     * Put the Xenon identity on the session.
     *
     * Only the identifier, the display fields and the account state: never
     * capabilities. Capabilities are resolved from the database per request by
     * `resolveActor`, so a role removed at 14:00 stops working at 14:00 rather
     * than whenever the session happens to be refreshed.
     */
    async session({ session, user }) {
      const record = await prisma.user.findUnique({
        where: { id: user.id },
        select: {
          publicId: true,
          displayName: true,
          avatarUrl: true,
          status: true,
          whitelistState: true,
          onboardingStep: true,
        },
      });

      session.user.id = user.id;
      session.user.publicId = record?.publicId ?? null;
      session.user.name = record?.displayName ?? session.user.name;
      session.user.image = record?.avatarUrl ?? session.user.image;
      session.user.status = record?.status ?? 'ACTIVE';
      session.user.whitelistState = record?.whitelistState ?? 'NONE';
      session.user.onboardingStep = record?.onboardingStep ?? 'DISCORD_CONNECTED';

      return session;
    },
  },

  events: {
    async signOut(message) {
      // Database strategy hands us the session; delete the row so the cookie is
      // dead server-side and not merely forgotten by the browser.
      if ('session' in message && message.session?.sessionToken !== undefined) {
        await prisma.session
          .deleteMany({ where: { sessionToken: message.session.sessionToken } })
          .catch(() => undefined);
      }
    },
  },
};
