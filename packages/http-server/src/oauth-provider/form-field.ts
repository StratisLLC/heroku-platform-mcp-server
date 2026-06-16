/**
 * Helpers for reading text fields out of a parsed `FormData`.
 *
 * `FormData.get` returns `string | File | null`. The OAuth endpoints only ever
 * expect text fields, so these coerce non-string entries (a `File`, or an
 * absent key) to a safe default rather than risk stringifying a `File` to
 * `'[object File]'`.
 */

/** Read a form field as a string; non-string or absent fields become `''`. */
export function formField(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
}

/** Read an optional form field; non-string or absent fields become `undefined`. */
export function formFieldOptional(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  return typeof value === 'string' ? value : undefined;
}
