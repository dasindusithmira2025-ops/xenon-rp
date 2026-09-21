'use client';

import Link from 'next/link';
import * as React from 'react';

import { Button } from '@xenon/ui';

import { StatusPage } from '~/components/site/status-pages';

/**
 * Root error boundary.
 *
 * `error.digest` is the only thing Next.js lets through from a server error, by
 * design: the message could name a table or a connection string. Showing the
 * digest gives support something to correlate against the server logs without
 * leaking anything.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  React.useEffect(() => {
    console.error('[web] render error', error);
  }, [error]);

  return (
    <StatusPage
      code="500"
      title="Something broke"
      description={
        <>
          That is on us, not you. Try again in a moment.
          {error.digest === undefined ? null : (
            <>
              <br />
              <span className="mt-3 inline-block font-mono text-xs text-ink-muted">
                Reference {error.digest}
              </span>
            </>
          )}
        </>
      }
    >
      <Button variant="accent" onClick={reset}>
        Try again
      </Button>
      <Button variant="ghost" asChild>
        <Link href="/">Back to the city</Link>
      </Button>
    </StatusPage>
  );
}
