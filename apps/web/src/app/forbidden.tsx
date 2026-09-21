import Link from 'next/link';

import { Button } from '@xenon/ui';

import { StatusPage } from '~/components/site/status-pages';

/**
 * Rendered by `forbidden()` when a signed-in actor lacks the capability. The
 * message deliberately does not name the missing permission: that would map the
 * authorization model for anyone probing it.
 */
export default function Forbidden(): React.ReactElement {
  return (
    <StatusPage
      code="403"
      title="Not your door"
      description="Your account does not have access to this. If you believe that is wrong, ask a member of staff to check your roles."
    >
      <Button variant="accent" asChild>
        <Link href="/portal">Your portal</Link>
      </Button>
      <Button variant="ghost" asChild>
        <Link href="/support">Open a ticket</Link>
      </Button>
    </StatusPage>
  );
}
