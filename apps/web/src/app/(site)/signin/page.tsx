import Link from 'next/link';
import { redirect } from 'next/navigation';

import { hasDevLogin } from '@xenon/config/server';
import { Button, Panel } from '@xenon/ui';

import { signInWithDiscord } from './actions';

import type { Metadata } from 'next';

import { XenonMark } from '~/components/brand/wordmark';
import { MediaSlot } from '~/components/media/media-slot';
import { currentActor } from '~/server/context';

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to XenonRP with Discord to apply, manage your characters and get support.',
  robots: { index: false, follow: false },
};

/**
 * Sign-in.
 *
 * One provider and one button. Discord is the community's identity system, and
 * offering a password field would create a second credential to phish with no
 * benefit to anybody.
 *
 * `callbackUrl` comes from the query string and is validated before use: an
 * unchecked value here is an open redirect, which is how a phishing link ends
 * up pointing at a legitimate Xenon domain.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const [actor, params] = await Promise.all([currentActor(), searchParams]);

  const raw = params.callbackUrl;
  const requested = typeof raw === 'string' ? raw : '/portal';
  // Only same-site, absolute paths. Anything else - a scheme, a host, a
  // protocol-relative `//evil.example` - falls back to the portal.
  const callbackUrl = /^\/(?!\/)/.test(requested) ? requested : '/portal';

  if (actor.userId !== null) redirect(callbackUrl);

  const error = typeof params.error === 'string' ? params.error : null;

  return (
    <div className="relative grid min-h-dvh lg:grid-cols-2">
      <MediaSlot
        src={null}
        alt=""
        slot="signin.art"
        seed={2}
        className="absolute inset-0 size-full lg:relative lg:order-2"
        sizes="(max-width: 1024px) 100vw, 50vw"
      />
      <div aria-hidden className="absolute inset-0 bg-void/85 lg:hidden" />

      <div className="relative flex items-center justify-center px-5 py-24 lg:order-1 lg:bg-void lg:px-12">
        <div className="flex w-full max-w-sm flex-col gap-8">
          <Link href="/" className="inline-flex items-center gap-3">
            <XenonMark className="size-8" />
            <span className="font-display text-sm font-extrabold tracking-[0.18em] text-ink">
              XENON
            </span>
          </Link>

          <div className="flex flex-col gap-3">
            <h1 className="font-display text-headline font-black text-ink uppercase">
              Enter the city
            </h1>
            <p className="leading-relaxed text-ink-secondary">
              Xenon uses your Discord account as your identity. Your XN number, applications and
              characters all belong to that account.
            </p>
          </div>

          {error === null ? null : (
            <Panel tone="ghost" className="border-danger/40 bg-danger/10 text-sm text-danger">
              Sign-in did not complete. Try again, and if it keeps failing check that you are signed
              in to the right Discord account.
            </Panel>
          )}

          <form action={signInWithDiscord} className="flex flex-col gap-3">
            <input type="hidden" name="callbackUrl" value={callbackUrl} />
            <Button type="submit" variant="accent" size="xl" className="w-full">
              Continue with Discord
            </Button>
          </form>

          {hasDevLogin() ? (
            <Panel tone="ghost" className="border-warning/30 bg-warning/5">
              <p className="text-xs leading-relaxed text-warning">
                Development sign-in is enabled. <code className="font-mono">/api/dev/session</code>{' '}
                will sign you in as a seeded fixture account without Discord. This route does not
                exist when NODE_ENV is production.
              </p>
            </Panel>
          ) : null}

          <p className="text-xs leading-relaxed text-ink-muted">
            By continuing you agree to the{' '}
            <Link href="/terms" className="text-ink-secondary underline underline-offset-2">
              terms
            </Link>{' '}
            and the{' '}
            <Link href="/privacy" className="text-ink-secondary underline underline-offset-2">
              privacy notice
            </Link>
            .
          </p>
        </div>
      </div>
    </div>
  );
}
