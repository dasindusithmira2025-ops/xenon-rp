import { NextResponse } from 'next/server';

import { autosave } from '@xenon/applications';
import { toSafeMessage } from '@xenon/core';
import { prisma } from '@xenon/database';
import { autosaveInput } from '@xenon/validation';

import { currentActor } from '~/server/context';

/**
 * Autosave endpoint.
 *
 * A route handler rather than a server action for one specific reason: the
 * browser-close case. `fetch(..., { keepalive: true })` from a `pagehide`
 * handler survives the page being torn down, and a server action invocation
 * does not. Somebody who writes for forty minutes and then closes the tab must
 * not lose the last paragraph.
 *
 * Defences, in order:
 *
 *  - Session required. The service additionally checks that the submission
 *    belongs to this user, so an id alone is not enough.
 *  - `Sec-Fetch-Site` must be same-origin. Combined with the JSON content type
 *    - which a cross-origin form post cannot set without a preflight this
 *    endpoint does not answer - that is the CSRF story for a handler that
 *    takes no cookie-bearing form submission.
 *  - Optimistic concurrency on `revision`, so two tabs cannot silently
 *    overwrite each other.
 *  - Rate limited inside the service.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') {
    return NextResponse.json(
      { ok: false, message: 'Cross-origin request refused' },
      { status: 403 },
    );
  }

  const actor = await currentActor();
  if (actor.userId === null) {
    return NextResponse.json({ ok: false, message: 'Sign in to continue.' }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: 'Malformed request.' }, { status: 400 });
  }

  const parsed = autosaveInput.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, message: 'Malformed request.' }, { status: 422 });
  }

  try {
    const result = await autosave(prisma, actor, parsed.data);
    return NextResponse.json({
      ok: true,
      revision: result.revision,
      savedAt: result.savedAt.toISOString(),
    });
  } catch (error) {
    const status =
      error !== null && typeof error === 'object' && 'httpStatus' in error
        ? Number(error.httpStatus)
        : 500;

    if (status >= 500) console.error('[autosave] failed', error);

    return NextResponse.json(
      {
        ok: false,
        message: toSafeMessage(error),
        // The client needs to distinguish "reload, another tab wrote" from
        // "try again in a moment", because the recovery is different.
        conflict: status === 409,
      },
      { status: Number.isFinite(status) ? status : 500 },
    );
  }
}
