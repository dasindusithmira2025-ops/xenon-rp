import { randomBytes } from 'node:crypto';

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { hasDevLogin } from '@xenon/config/server';
import { DEV_DISCORD_FIXTURES, isDevFixtureDiscordId, prisma } from '@xenon/database';

/**
 * Development sign-in.
 *
 * Creates a real `Session` row for a seeded fixture account and sets the same
 * cookie Auth.js would, so every downstream check - `auth()`, `resolveActor`,
 * capability gates - behaves exactly as it does in production. The E2E suite
 * uses it instead of driving a live Discord OAuth flow, which would need real
 * credentials and a browser session on discord.com.
 *
 * Three independent guards, because this route signs in as anybody:
 *
 *  1. `hasDevLogin()` requires AUTH_DEV_LOGIN *and* a non-production NODE_ENV,
 *     so a leaked flag in a production environment does nothing.
 *  2. Only the exact non-snowflake fixture keys are accepted, so it cannot be
 *     pointed at a real Discord account even in development.
 *  3. A 404 rather than a 403 when disabled: the route should not advertise
 *     that it exists.
 */

export async function GET(request: Request): Promise<NextResponse> {
  if (!hasDevLogin()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const url = new URL(request.url);
  const discordId = url.searchParams.get('discordId') ?? DEV_DISCORD_FIXTURES.player.discordId;
  const redirectTo = url.searchParams.get('redirectTo') ?? '/portal';

  if (!isDevFixtureDiscordId(discordId)) {
    return NextResponse.json(
      { error: 'Only seeded fixture accounts can be used here. Run `pnpm db:seed:dev`.' },
      { status: 400 },
    );
  }

  const account = await prisma.discordAccount.findUnique({
    where: { discordId },
    select: { userId: true, user: { select: { publicId: true, displayName: true } } },
  });

  if (account === null) {
    return NextResponse.json(
      { error: `No fixture account ${discordId}. Run \`pnpm db:seed:dev\`.` },
      { status: 404 },
    );
  }

  const sessionToken = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await prisma.session.create({
    data: { sessionToken, userId: account.userId, expires },
  });

  const store = await cookies();
  // The unprefixed name is what Auth.js uses over plain HTTP; the `__Secure-`
  // form only applies to HTTPS deployments, which this route cannot reach.
  store.set('authjs.session-token', sessionToken, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    expires,
  });

  // Only same-site paths, for the same reason the sign-in page validates its
  // callback: an unchecked redirect is an open redirect.
  const safeRedirect = /^\/(?!\/)/.test(redirectTo) ? redirectTo : '/portal';

  return NextResponse.redirect(new URL(safeRedirect, url.origin));
}
