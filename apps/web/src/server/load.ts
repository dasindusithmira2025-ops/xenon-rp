import 'server-only';

import { forbidden, notFound, unauthorized } from 'next/navigation';

import { ForbiddenError, NotFoundError, UnauthenticatedError } from '@xenon/core';

/**
 * Map a domain error to the right HTTP boundary.
 *
 * Domain services throw - `NotFoundError` when a public id resolves to
 * nothing, `ForbiddenError` when it belongs to somebody else - because that is
 * the honest shape for code that has no idea it is running inside a request.
 * Next knows nothing about those types, so without this a mistyped application
 * id renders "Something broke, error 500" when the truthful answer is 404.
 *
 * One helper rather than a try/catch per page: nine detail pages would be nine
 * chances to forget, and the one that forgot would be discovered by a player
 * seeing a server error.
 *
 * Deliberately narrow. Anything that is not one of these three is a genuine
 * fault and is rethrown so the error boundary and the logs still see it.
 */
export async function loadOrStatus<T>(load: Promise<T>): Promise<T> {
  try {
    return await load;
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof ForbiddenError) forbidden();
    if (error instanceof UnauthenticatedError) unauthorized();
    throw error;
  }
}
