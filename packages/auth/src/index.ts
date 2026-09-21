import NextAuth from 'next-auth';

import { authConfig } from './config';

import './types';

/**
 * The single Auth.js instance.
 *
 * Created once and re-exported so the route handler and every server component
 * share one configuration; a second `NextAuth()` call elsewhere would quietly
 * produce a second cookie namespace.
 *
 * The explicit `ReturnType` annotation is not decoration. Auth.js infers types
 * that reference modules deep inside its own package, which TypeScript cannot
 * name from a consumer, and the declaration would not be portable without it.
 */
const instance: ReturnType<typeof NextAuth> = NextAuth(authConfig);

export const handlers = instance.handlers;
export const auth = instance.auth;
export const signIn = instance.signIn;
export const signOut = instance.signOut;

export { authConfig } from './config';
export { xenonAdapter } from './adapter';
export * from './actor';
