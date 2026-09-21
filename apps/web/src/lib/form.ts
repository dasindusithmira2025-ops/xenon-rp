/**
 * `FormData` readers.
 *
 * `FormData.get` returns `string | File | null`, so every read needs narrowing
 * before it can be used as text. Doing that here rather than at each call site
 * keeps a `File` from being stringified into `[object Object]` and quietly
 * saved as somebody's display name.
 */

/** A text field, or the empty string when absent or a file. */
export function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
}

/** A text field, or undefined when empty. For optional inputs. */
export function optionalText(form: FormData, key: string): string | undefined {
  const value = text(form, key).trim();
  return value.length === 0 ? undefined : value;
}

/** Checkboxes post `"on"` or nothing at all. */
export function checkbox(form: FormData, key: string): boolean {
  const value = form.get(key);
  return value === 'on' || value === 'true' || value === '1';
}

/** Every value of a repeated field, e.g. a checkbox group. */
export function textList(form: FormData, key: string): string[] {
  return form
    .getAll(key)
    .filter((value): value is string => typeof value === 'string')
    .filter((value) => value.length > 0);
}

/** A number field, or undefined when absent or unparseable. */
export function number(form: FormData, key: string): number | undefined {
  const value = text(form, key).trim();
  if (value.length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
