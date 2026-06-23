/**
 * Gated, status-only auth diagnostics for the `/mcp` and `/mcp-codemode`
 * bearer paths.
 *
 * Turned on only when `HEROKUMCP_AUTH_DEBUG` is set to a non-falsey value
 * (default OFF). When on, each instrumentation point emits ONE line to stderr
 * naming the precise rejection branch (token missing/store-miss/user-not-found,
 * session-init reauth/no-stored-token/decrypt-failure) plus relevant resource
 * identifiers. NEVER logs tokens, auth headers, secrets, or response bodies —
 * and every line is run through {@link scrubString} as defence in depth.
 *
 * Mirrors the `HEROKUMCP_PROBE_DEBUG` gate in `@heroku-mcp/core`'s prober so
 * operators can toggle either independently.
 */

import { scrubString } from '@heroku-mcp/core';

/** Values that, used as `HEROKUMCP_AUTH_DEBUG`, leave debug logging off. */
const AUTH_DEBUG_OFF_VALUES = new Set(['', '0', 'false', 'off', 'no']);

/**
 * Whether auth-reason logging is enabled via `HEROKUMCP_AUTH_DEBUG`. Default
 * OFF — the env var must be set to a non-falsey value to turn it on. Read per
 * call so operators/tests can toggle it without re-importing.
 */
export function authDebugEnabled(): boolean {
  const v = process.env.HEROKUMCP_AUTH_DEBUG;
  return v !== undefined && !AUTH_DEBUG_OFF_VALUES.has(v.trim().toLowerCase());
}

/**
 * Emit one `[auth-debug]` diagnostic line to stderr when `HEROKUMCP_AUTH_DEBUG`
 * is enabled (default off). `fields` are joined as `key=value` pairs; pass only
 * status codes, reason strings, and resource identifiers — never token values,
 * headers, or bodies. The whole line is scrubbed before printing as a backstop.
 */
export function logAuthDebug(event: string, fields: Record<string, string | undefined> = {}): void {
  if (!authDebugEnabled()) return;
  const parts = [`event=${event}`];
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) parts.push(`${k}=${v}`);
  }
  console.error(`[auth-debug] ${scrubString(parts.join(' '))}`);
}
