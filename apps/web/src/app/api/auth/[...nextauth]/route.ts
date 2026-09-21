import { handlers } from '@xenon/auth';

/**
 * Auth.js route handler.
 *
 * The only place the OAuth exchange happens. Provider tokens are written to the
 * `accounts` table by the adapter and never leave the server; the browser only
 * ever holds an opaque session cookie.
 */
export const { GET, POST } = handlers;
