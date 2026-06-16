/**
 * `dry_run` helper for mutating tools (ARCHITECTURE.md §8.2, Phase 2a
 * Decisions 3-6).
 *
 * Every mutating tool accepts `dry_run: boolean` (default false). When true,
 * the tool validates inputs and builds the would-be HTTP request, then stops
 * — instead of executing the request it returns this preview envelope:
 *
 *   {
 *     ok: true,
 *     dry_run: true,
 *     data: {
 *       request: { method, url, headers, body },
 *       description: "Plain-language summary of what would happen."
 *     },
 *     meta: { requestId: null, rateLimitRemaining: ..., cached: false }
 *   }
 *
 * The request `headers` are sanitized: `Authorization` and any
 * `Authorization`-like header is stripped so the preview can be safely shown
 * to a model or logged. The intent is "would I have leaked credentials?" not
 * "perfect transcript of the request." Heroku-specific headers (Range,
 * If-None-Match, etc.) are preserved.
 */

/** Heroku HTTP methods we issue from mutating tools. */
export type DryRunMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** Sanitized request preview embedded in a {@link DryRunResult}. */
export interface DryRunRequest {
  method: DryRunMethod;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Metadata reported back to the caller. Mirrors `SuccessMeta` in the
 *  platform-mcp envelope but pinned to the dry-run shape. */
export interface DryRunMeta {
  /** Always null — no request was issued. */
  requestId: null;
  /** Current cached rate-limit budget; null if unknown. */
  rateLimitRemaining: number | null;
  /** Always false — there is no cache hit on a dry run. */
  cached: false;
}

/** The shape returned from a dry-run preview. */
export interface DryRunResult {
  ok: true;
  dry_run: true;
  data: {
    request: DryRunRequest;
    description: string;
  };
  meta: DryRunMeta;
}

/** Inputs to {@link buildDryRunResponse}. */
export interface BuildDryRunInput {
  method: DryRunMethod;
  /** Full URL (including any query string). */
  url: string;
  /** Headers as the client would send them; the helper sanitises secrets. */
  headers?: Record<string, string>;
  /** Request body. Pass `null` for verb-less calls (DELETE, no-body POST). */
  body?: unknown;
  /** Plain-language summary of what would happen. */
  description: string;
  /** Optional rate-limit budget snapshot. */
  rateLimitRemaining?: number | null;
}

/**
 * Build a {@link DryRunResult} for a tool that has chosen not to issue its
 * write. Strips any Authorization-like header from the preview so the envelope
 * is safe to log.
 */
export function buildDryRunResponse(input: BuildDryRunInput): DryRunResult {
  const headers = sanitizeHeaders(input.headers ?? {});
  return {
    ok: true,
    dry_run: true,
    data: {
      request: {
        method: input.method,
        url: input.url,
        headers,
        body: input.body ?? null,
      },
      description: input.description,
    },
    meta: {
      requestId: null,
      rateLimitRemaining: input.rateLimitRemaining ?? null,
      cached: false,
    },
  };
}

/**
 * Header names that must never appear in a dry-run preview. The list is
 * deliberately small — Heroku-specific operational headers (Range,
 * If-None-Match, Content-Type, Accept, User-Agent) stay so the preview is
 * still useful for debugging. The bearer token, basic-auth credentials, and
 * any cookie-like header are stripped.
 */
const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
]);

/** Remove sensitive headers from a header map. Case-insensitive on input,
 *  preserves original casing on output for non-sensitive headers. */
export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADER_NAMES.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}
