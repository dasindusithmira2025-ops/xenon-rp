import Link from 'next/link';

import { Button } from '@xenon/ui';

import { StatusPage } from '~/components/site/status-pages';

/**
 * Rendered by `unauthorized()` when a page needs a session and there is none.
 * Deliberately not a redirect: the URL survives, so signing in returns the
 * player to the page they actually wanted.
 */
export default function Unauthorized(): React.ReactElement {
  return (
    <StatusPage
      code="401"
      title="Sign in to continue"
      description="This part of Xenon belongs to your account. Sign in with Discord and you will land right back here."
    >
      <Button variant="accent" asChild>
        <Link href="/signin">Sign in with Discord</Link>
      </Button>
      <Button variant="ghost" asChild>
        <Link href="/">Back to the city</Link>
      </Button>
    </StatusPage>
  );
}
