import 'server-only';

import { isDomainError, toSafeMessage, ValidationError } from '@xenon/core';

import type { z } from 'zod';
import type { ActionResult } from '~/lib/action-result';

/**
 * Server action plumbing.
 *
 * Actions return a discriminated result rather than throwing across the
 * server/client boundary. A thrown error in a server action reaches the client
 * as an opaque digest with no message, which is correct for security and
 * useless for a form that needs to say which field is wrong.
 *
 * The translation from domain error to user-facing message happens once, here.
 * Developer detail stays on the server; only `safeMessage` crosses the wire.
 */

export { actionError, actionOk, type ActionResult } from '~/lib/action-result';

/**
 * Run an action body and translate anything it throws.
 *
 * Unknown exceptions collapse to a generic message and are logged server-side:
 * a stack trace or a connection string must never reach a browser, and
 * `toSafeMessage` is what guarantees that regardless of what went wrong.
 */
export async function runAction<T>(body: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await body() };
  } catch (error) {
    if (error instanceof ValidationError) {
      return {
        ok: false,
        code: error.code,
        message: error.safeMessage,
        fieldErrors: Object.fromEntries(
          Object.entries(error.fieldErrors).map(([key, messages]) => [key, [...messages]]),
        ),
      };
    }

    if (isDomainError(error)) {
      return { ok: false, code: error.code, message: error.safeMessage };
    }

    console.error('[action] unhandled error', error);
    return { ok: false, code: 'INTERNAL', message: toSafeMessage(error) };
  }
}

/**
 * Parse input with a schema, raising the domain validation error on failure.
 *
 * Every action parses its own input even when the form already did. The client
 * check is a convenience; this one is the boundary, and it is the only one an
 * attacker cannot skip by posting directly.
 */
export function parseInput<TSchema extends z.ZodType>(
  schema: TSchema,
  input: unknown,
): z.output<TSchema> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const fieldErrors: Record<string, string[]> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_form';
    (fieldErrors[key] ??= []).push(issue.message);
  }

  throw new ValidationError(fieldErrors);
}

/** Read a `FormData` into a plain object, collapsing single-valued entries. */
export function formToObject(form: FormData): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  for (const [key, value] of form.entries()) {
    if (value instanceof File) continue;

    const existing = output[key];
    if (existing === undefined) {
      output[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      output[key] = [existing, value];
    }
  }

  return output;
}

/** Checkbox inputs post `"on"` or nothing at all; normalise to a boolean. */
export function formBoolean(form: FormData, key: string): boolean {
  const value = form.get(key);
  return value === 'on' || value === 'true' || value === '1';
}

/** Read a repeated field, e.g. a multi-select or a checkbox group. */
export function formList(form: FormData, key: string): string[] {
  return form
    .getAll(key)
    .filter((value): value is string => typeof value === 'string')
    .filter((value) => value.length > 0);
}
