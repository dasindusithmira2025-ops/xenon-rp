/**
 * The shape a server action returns.
 *
 * Lives outside `~/server` because client components legitimately need this
 * type to handle a result, and `~/server/action.ts` imports `server-only` -
 * which turns a type import from a client component into a build error rather
 * than the no-op it looks like.
 *
 * Nothing here touches the request, the database or a secret; it is a shape and
 * two constructors.
 */

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | {
      ok: false;
      code: string;
      message: string;
      /** Per-field messages, keyed by field name. Only set for validation failures. */
      fieldErrors?: Record<string, string[]>;
    };

export function actionOk(): ActionResult;
export function actionOk<T>(data: T): ActionResult<T>;
export function actionOk<T>(data?: T): ActionResult<T | undefined> {
  return { ok: true, data: data as T };
}

export function actionError(
  code: string,
  message: string,
  fieldErrors?: Record<string, string[]>,
): ActionResult<never> {
  return fieldErrors === undefined
    ? { ok: false, code, message }
    : { ok: false, code, message, fieldErrors };
}
