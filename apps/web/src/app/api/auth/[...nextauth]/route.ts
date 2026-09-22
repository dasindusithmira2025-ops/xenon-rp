import { handlers } from '@xenon/auth';

/**
 * Auth.js route handler.
 *
 * The only place the OAuth exchange happens. The adapter stores the provider
 * identity pointer but clears OAuth tokens; the browser only holds an opaque
 * Xenon database-session cookie.
 */
export const { GET, POST } = handlers;
