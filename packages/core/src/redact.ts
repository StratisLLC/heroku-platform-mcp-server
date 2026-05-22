/**
 * Secret redaction for log lines, audit entries, and error payloads bubbled
 * back to MCP hosts (ARCHITECTURE.md §9).
 *
 * Rules:
 *   1. Keys whose lowercased name matches a sensitive set (`password`, `token`,
 *      `secret`, `client_secret`, `access_token`, `refresh_token`, `api_key`,
 *      `authorization`) have their values fully replaced.
 *   2. Inside string values, anything matching the Heroku API token pattern
 *      `HRKU-[a-f0-9-]+` is replaced (preserving surrounding text).
 *   3. Inside string values, an HTTP `Bearer <token>` substring has its token
 *      replaced (the literal `Bearer ` prefix is kept so log readers can still
 *      see "this was an Authorization header").
 *   4. The `config_vars` map is special-cased: every string leaf below it is
 *      redacted, regardless of key name. Heroku config_vars are by definition
 *      caller-provided secrets.
 *
 * Out of scope: `config_vars_get` — that tool is specifically a getter, so its
 *  return value is rendered without redaction (see ARCHITECTURE.md §9).
 *
 * Non-goals: this is not a general PII scrubber. It targets the specific
 *  Heroku-side secrets we know we'll see.
 */

/** Default set of object keys whose values are considered secrets. */
export const DEFAULT_SENSITIVE_KEYS: readonly string[] = [
  'password',
  'token',
  'secret',
  'client_secret',
  'access_token',
  'refresh_token',
  'api_key',
  'authorization',
];

/** Default placeholder used in place of a redacted value. */
export const DEFAULT_REDACTED_PLACEHOLDER = '[REDACTED]';

/** Heroku-issued API token prefix; UUID-shaped but lower-case hex with dashes. */
const HRKU_TOKEN_PATTERN = /HRKU-[a-f0-9-]+/gi;

/** HTTP Authorization header bearer-token shape; preserves the literal `Bearer ` so the redactor
 *  is visibly an Authorization-header redaction. The token body is any run of non-whitespace
 *  non-quote/comma/semicolon characters. */
const BEARER_TOKEN_PATTERN = /(Bearer\s+)([^\s"',;]+)/gi;

export interface RedactOptions {
  /** String used to replace each redacted value. Defaults to `"[REDACTED]"`. */
  placeholder?: string;
  /** Extra key names (case-insensitive) to treat as sensitive. */
  additionalSensitiveKeys?: readonly string[];
  /** Extra key names (case-insensitive) whose values should be treated as
   *  config-var-style maps (every string leaf below is redacted). */
  additionalSecretMapKeys?: readonly string[];
}

/**
 * Return a redacted copy of `value`. The input is never mutated. JSON-style
 * inputs only: strings, numbers, booleans, null, plain objects, arrays.
 * Class instances and non-plain objects are passed through unchanged
 * (otherwise we'd risk re-creating them with wrong prototypes).
 *
 * Cycles are detected and the second occurrence is replaced with the literal
 * `"[CYCLE]"` to keep this function infallible on any input shape.
 */
export function redact(value: unknown, opts: RedactOptions = {}): unknown {
  const placeholder = opts.placeholder ?? DEFAULT_REDACTED_PLACEHOLDER;
  const sensitiveKeys = new Set(
    [...DEFAULT_SENSITIVE_KEYS, ...(opts.additionalSensitiveKeys ?? [])].map((k) =>
      k.toLowerCase(),
    ),
  );
  const secretMapKeys = new Set(
    ['config_vars', ...(opts.additionalSecretMapKeys ?? [])].map((k) => k.toLowerCase()),
  );
  const seen = new WeakSet<object>();

  const walk = (v: unknown, inSecretMap: boolean): unknown => {
    if (typeof v === 'string') {
      return inSecretMap ? placeholder : scrubString(v, placeholder);
    }
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return '[CYCLE]';
    if (!isPlainContainer(v)) return v;
    seen.add(v);

    if (Array.isArray(v)) return v.map((item) => walk(item, inSecretMap));

    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const lk = k.toLowerCase();
      if (sensitiveKeys.has(lk)) {
        out[k] = placeholder;
      } else if (secretMapKeys.has(lk)) {
        out[k] = walk(val, true);
      } else {
        out[k] = walk(val, inSecretMap);
      }
    }
    return out;
  };

  return walk(value, false);
}

/** Convenience: redact, then `JSON.stringify`. Used by the logger and audit
 *  writer to produce JSON-safe output in one call. */
export function redactToJson(value: unknown, opts?: RedactOptions): string {
  return JSON.stringify(redact(value, opts));
}

/** Apply token/bearer scrubbing to a single string. Useful for log-message
 *  templates where the surrounding string is not itself an object key/value. */
export function scrubString(input: string, placeholder = DEFAULT_REDACTED_PLACEHOLDER): string {
  let out = input.replace(HRKU_TOKEN_PATTERN, placeholder);
  out = out.replace(BEARER_TOKEN_PATTERN, `$1${placeholder}`);
  return out;
}

function isPlainContainer(v: object): boolean {
  if (Array.isArray(v)) return true;
  const proto = Object.getPrototypeOf(v) as object | null;
  return proto === Object.prototype || proto === null;
}
