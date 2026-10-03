'use client';

import { usePathname, useRouter } from 'next/navigation';
import * as React from 'react';

/**
 * Filter navigation that does not blank the table.
 *
 * Every filtered screen in the control centre keeps its state in the URL, so
 * changing a filter is a navigation. Left to itself that navigation hits the
 * route's `loading.tsx`, the rows staff were reading are replaced by a
 * skeleton, and the whole page flashes because someone picked a different
 * status from a dropdown.
 *
 * Wrapping the push in a transition tells React to hold the current screen
 * while the new one streams. The rows stay on screen and readable, and the only
 * thing that changes is `pending` - which callers surface as a thin rail. That
 * is the difference between "this list is being refreshed" and "this list has
 * been thrown away".
 *
 * `pending` is a real signal with no duration attached to it: it is true while
 * a request is genuinely outstanding and false the moment it is not, which is
 * why the rail it drives is indeterminate.
 */
export function useFilterNavigation(): {
  /** Replace the query string, keeping the current rows visible. */
  navigate: (search: URLSearchParams | null) => void;
  pending: boolean;
  pathname: string;
} {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = React.useTransition();

  const navigate = React.useCallback(
    (search: URLSearchParams | null) => {
      const query = search === null ? '' : search.toString();
      startTransition(() => {
        router.push(query === '' ? pathname : `${pathname}?${query}`);
      });
    },
    [router, pathname],
  );

  return { navigate, pending, pathname };
}
