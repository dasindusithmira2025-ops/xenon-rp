'use server';

import { redirect } from 'next/navigation';

import { signIn, signOut } from '@xenon/auth';
import { serverEnv } from '@xenon/config/server';
import { enforceRateLimit } from '@xenon/jobs';

import { currentActor, rateLimitIdentity } from '~/server/context';

/**
 * Sign-in and sign-out actions.
 *
 * Kept as server actions rather than links so the OAuth start is a POST. A GET
 * that begins an authentication flow is trivially triggered from another site
 * by an image tag, and CSRF protection on a form is something the framework
 * already gives us.
 */

export async function signInWithDiscord(formData: FormData): Promise<void> {
  if (serverEnv.DISCORD_MODE !== 'enabled') redirect('/signin?error=Configuration');

  const actor = await currentActor();
  await enforceRateLimit('signIn', rateLimitIdentity(actor));

  const requested = formData.get('callbackUrl');
  // Re-validated here and not only in the page: this action is directly
  // callable, so trusting the hidden field would reopen the redirect hole the
  // page closes.
  const callbackUrl =
    typeof requested === 'string' && /^\/(?!\/)/.test(requested) ? requested : '/portal';

  await signIn('discord', { redirectTo: callbackUrl });
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: '/' });
}
