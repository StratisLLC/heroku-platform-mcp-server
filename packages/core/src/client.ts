/**
 * HTTP client that ties every other primitive together (ARCHITECTURE.md §7).
 *
 * Per-request pipeline:
 *
 *   1. Build URL + headers (Authorization, Accept, User-Agent, optional ETag,
 *      caller extras).
 *   2. Validate the URL host against the allowlist (§11).
 *   3. Acquire a rate-limit slot (serial below the threshold).
 *   4. fetch() with an AbortController-driven timeout.
 *   5. Update the rate-limit tracker from `RateLimit-Remaining`.
 *   6. On 200/206: parse body, store ETag if returned, return wrapped result.
 *   7. On 304: serve cached body.
 *   8. On 4xx/5xx: parse Heroku error body, map to typed {@link HerokuError},
 *      retry per backoff policy if eligible (429/503; POST needs Retry-After;
 *      PATCH/DELETE/PUT need `idempotent: true`).
 *   9. After mutating methods: append a single audit line capturing the final
 *      outcome (success or failure).
 *
 * The client never returns a tool-response envelope. It either resolves with
 * a structured {@link ClientSuccess} or throws a typed {@link HerokuError}.
 * Tool implementations are responsible for the envelope conversion.
 */

import { type HerokuError, NetworkError, isHerokuError, mapHttpResponseToError } from './errors.js';
import type { ETagCache } from './etag.js';
import { parsePaginationMeta, type PaginationMeta } from './pagination.js';
import type { RateLimitRelease, RateLimitTracker } from './ratelimit.js';
import type { AuditEntry, AuditLogger, AuditServer } from './audit.js';

/** Heroku hostnames the client is permitted to contact (ARCHITECTURE.md §11). */
export const HEROKU_ALLOWED_HOSTS: readonly string[] = [
  'api.heroku.com',
  'id.heroku.com',
  'addons.heroku.com',
  'api.data.heroku.com',
];

/** Exponential backoff schedule for retryable failures (§7). */
export const RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000, 4000];

/** Default per-request timeout (§7). */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Status codes considered retryable, subject to method-specific gating below. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 503]);

/** Sleeper for the retry loop; injectable for tests. */
export type Sleeper = (ms: number) => Promise<void>;

const defaultSleeper: Sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface ClientConfig {
  /** Base URL; defaults to `https://api.heroku.com`. */
  baseUrl?: string;
  /** Lazy token provider. Called once per attempt. Returning null produces an unauthenticated request. */
  token: () => Promise<string | null> | string | null;
  /** Heroku API version negotiated in the Accept header (`vnd.heroku+json; version=N`). Defaults to `3`. */
  apiVersion?: string;
  /** User-Agent value. Defaults to `herokumcp/<unknown> (<server>)`. */
  userAgent?: string;
  /** Server name written into audit entries. Defaults to `"platform"`. */
  server?: AuditServer;
  /** Token fingerprint (first 16 hex chars of SHA-256(token)) for audit entries. */
  tokenFingerprint?: string;
  /** Injectable fetch — defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  rateLimit?: RateLimitTracker;
  etagCache?: ETagCache;
  audit?: AuditLogger;
  /** Override the host allowlist (tests only). */
  allowedHosts?: readonly string[];
  /** Override the default per-request timeout in milliseconds. */
  defaultTimeoutMs?: number;
  /** Maximum total request attempts (initial + retries). Defaults to 5. */
  maxAttempts?: number;
  /** Replace the built-in retry schedule. */
  retryDelaysMs?: readonly number[];
  /** Injectable sleeper for tests. */
  sleep?: Sleeper;
}

export interface RequestOptions {
  /** HTTP method. Defaults to `GET`. */
  method?: string;
  /** Path joined to `baseUrl`, e.g. `"/apps"`. May be a full URL if pointing at an allowed host. */
  path: string;
  /** Query string parameters; serialised to `?k=v&…` after omitting undefined values. */
  query?: Record<string, string | number | boolean | undefined>;
  /** Request body. JSON.stringify'd; `Content-Type: application/json` is set automatically. */
  body?: unknown;
  /** Extra headers, merged onto the defaults. */
  headers?: Record<string, string>;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Skip the ETag cache for this call (used by probes and forced refreshes). */
  noCache?: boolean;
  /** Override retry eligibility for PATCH/PUT/DELETE. Defaults to true for those methods, false for POST. */
  idempotent?: boolean;
  /** Tool name for audit logging. */
  tool?: string;
  /** Human-readable target for audit logging. */
  target?: string;
}

export interface ClientSuccess<T = unknown> {
  ok: true;
  status: number;
  body: T;
  /** Lower-cased response headers (subset surfaced to callers). */
  headers: Record<string, string>;
  /** True iff the response body came from the ETag cache (304 hit). */
  cached: boolean;
  requestId?: string;
  rateLimitRemaining?: number;
  pagination?: PaginationMeta;
}

export interface HerokuClient {
  request<T = unknown>(opts: RequestOptions): Promise<ClientSuccess<T>>;
  get<T = unknown>(
    path: string,
    opts?: Omit<RequestOptions, 'path' | 'method'>,
  ): Promise<ClientSuccess<T>>;
  post<T = unknown>(
    path: string,
    body?: unknown,
    opts?: Omit<RequestOptions, 'path' | 'method' | 'body'>,
  ): Promise<ClientSuccess<T>>;
  patch<T = unknown>(
    path: string,
    body?: unknown,
    opts?: Omit<RequestOptions, 'path' | 'method' | 'body'>,
  ): Promise<ClientSuccess<T>>;
  put<T = unknown>(
    path: string,
    body?: unknown,
    opts?: Omit<RequestOptions, 'path' | 'method' | 'body'>,
  ): Promise<ClientSuccess<T>>;
  delete<T = unknown>(
    path: string,
    opts?: Omit<RequestOptions, 'path' | 'method'>,
  ): Promise<ClientSuccess<T>>;
}

/** Construct a {@link HerokuClient}. The same client can be used across requests. */
export function createClient(config: ClientConfig): HerokuClient {
  const baseUrl = stripTrailingSlash(config.baseUrl ?? 'https://api.heroku.com');
  const apiVersion = config.apiVersion ?? '3';
  const userAgent = config.userAgent ?? `herokumcp (${config.server ?? 'platform'})`;
  const server: AuditServer = config.server ?? 'platform';
  const tokenFingerprint = config.tokenFingerprint ?? 'unknown';
  const doFetch = config.fetch ?? globalThis.fetch;
  const allowedHosts = new Set(config.allowedHosts ?? HEROKU_ALLOWED_HOSTS);
  const defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = config.maxAttempts ?? RETRY_DELAYS_MS.length + 1;
  const delays = config.retryDelaysMs ?? RETRY_DELAYS_MS;
  const sleep = config.sleep ?? defaultSleeper;
  const rateLimit = config.rateLimit;
  const etagCache = config.etagCache;
  const audit = config.audit;
  const tokenProvider = config.token;

  async function request<T>(opts: RequestOptions): Promise<ClientSuccess<T>> {
    const method = (opts.method ?? 'GET').toUpperCase();
    const url = buildUrl(baseUrl, opts.path, opts.query);
    const parsed = new URL(url);
    if (!allowedHosts.has(parsed.hostname)) {
      throw new NetworkError(
        `Refusing to call disallowed host "${parsed.hostname}". Allowed hosts: ${[...allowedHosts].join(', ')}.`,
        { url },
      );
    }

    const isMutation = method !== 'GET' && method !== 'HEAD';
    const canCache = !opts.noCache && method === 'GET' && etagCache !== undefined;
    const idempotent = opts.idempotent ?? defaultIdempotency(method);

    let attempt = 0;
    let lastError: HerokuError | undefined;
    let auditStatus = 0;
    let auditRequestId: string | undefined;
    const requestStart = Date.now();

    try {
      while (attempt < maxAttempts) {
        attempt += 1;
        const outcome = await executeOnce<T>({
          method,
          url,
          opts,
          apiVersion,
          userAgent,
          tokenProvider,
          fetchFn: doFetch,
          rateLimit,
          etagCache,
          canCache,
          defaultTimeoutMs,
        });

        if (outcome.kind === 'success') {
          auditStatus = outcome.value.status;
          if (outcome.value.requestId !== undefined) auditRequestId = outcome.value.requestId;
          return outcome.value;
        }

        // Failure path.
        const status = outcome.status ?? 0;
        auditStatus = status;
        if (outcome.requestId !== undefined) auditRequestId = outcome.requestId;
        lastError = outcome.error;

        if (
          attempt < maxAttempts &&
          shouldRetry(method, status, outcome.retryAfterMs, idempotent)
        ) {
          const delay = nextDelay(delays, attempt, outcome.retryAfterMs);
          await sleep(delay);
          continue;
        }
        throw outcome.error;
      }
      // Loop fell through: shouldn't happen, but defensively throw the last error.
      throw lastError ?? new NetworkError('Request exhausted retries without an outcome.', { url });
    } finally {
      if (isMutation && audit) {
        const entry: AuditEntry = {
          server,
          tool: opts.tool ?? '(unknown)',
          method,
          url,
          tokenFp: tokenFingerprint,
          status: auditStatus,
          durationMs: Date.now() - requestStart,
        };
        if (opts.target !== undefined) entry.target = opts.target;
        if (auditRequestId !== undefined) entry.requestId = auditRequestId;
        await audit.append(entry).catch(() => undefined);
      }
    }
  }

  function get<T>(
    path: string,
    opts?: Omit<RequestOptions, 'path' | 'method'>,
  ): Promise<ClientSuccess<T>> {
    return request<T>({ ...opts, path, method: 'GET' });
  }
  function post<T>(
    path: string,
    body?: unknown,
    opts?: Omit<RequestOptions, 'path' | 'method' | 'body'>,
  ): Promise<ClientSuccess<T>> {
    return request<T>({ ...opts, path, method: 'POST', body });
  }
  function patch<T>(
    path: string,
    body?: unknown,
    opts?: Omit<RequestOptions, 'path' | 'method' | 'body'>,
  ): Promise<ClientSuccess<T>> {
    return request<T>({ ...opts, path, method: 'PATCH', body });
  }
  function put<T>(
    path: string,
    body?: unknown,
    opts?: Omit<RequestOptions, 'path' | 'method' | 'body'>,
  ): Promise<ClientSuccess<T>> {
    return request<T>({ ...opts, path, method: 'PUT', body });
  }
  function del<T>(
    path: string,
    opts?: Omit<RequestOptions, 'path' | 'method'>,
  ): Promise<ClientSuccess<T>> {
    return request<T>({ ...opts, path, method: 'DELETE' });
  }

  return { request, get, post, patch, put, delete: del };
}

// --------------------------------------------------------------------------
// Internal helpers
// --------------------------------------------------------------------------

interface ExecuteOnceArgs<T> {
  method: string;
  url: string;
  opts: RequestOptions;
  apiVersion: string;
  userAgent: string;
  tokenProvider: ClientConfig['token'];
  fetchFn: typeof globalThis.fetch;
  rateLimit: RateLimitTracker | undefined;
  etagCache: ETagCache | undefined;
  canCache: boolean;
  defaultTimeoutMs: number;
  _phantom?: T; // keeps T in scope for the return type
}

type ExecuteOutcome<T> =
  | { kind: 'success'; value: ClientSuccess<T> }
  | {
      kind: 'failure';
      error: HerokuError;
      status?: number;
      requestId?: string;
      retryAfterMs?: number;
    };

async function executeOnce<T>(args: ExecuteOnceArgs<T>): Promise<ExecuteOutcome<T>> {
  const {
    method,
    url,
    opts,
    apiVersion,
    userAgent,
    tokenProvider,
    fetchFn,
    rateLimit,
    etagCache,
    canCache,
    defaultTimeoutMs,
  } = args;

  const headers: Record<string, string> = {
    Accept: `application/vnd.heroku+json; version=${apiVersion}`,
    'User-Agent': userAgent,
  };
  const token = await Promise.resolve(tokenProvider());
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const cached = canCache && etagCache ? etagCache.get(method, url) : undefined;
  if (cached) headers['If-None-Match'] = cached.etag;

  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) headers[k] = v;
  }

  const release: RateLimitRelease = rateLimit ? await rateLimit.acquire() : noopRelease;

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    const init: RequestInit = { method, headers, signal: controller.signal };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    response = await fetchFn(url, init);
  } catch (err) {
    release();
    clearTimeout(timer);
    if (isAbortError(err)) {
      return {
        kind: 'failure',
        error: new NetworkError(`Request timed out after ${timeoutMs}ms.`, {
          url,
          timeoutMs,
          cause: err,
        }),
      };
    }
    return {
      kind: 'failure',
      error: new NetworkError(err instanceof Error ? err.message : String(err), {
        url,
        cause: err,
      }),
    };
  }
  clearTimeout(timer);
  release();

  const remaining = parseNumericHeader(response.headers, 'ratelimit-remaining');
  if (rateLimit) rateLimit.observe(remaining);
  const requestId = response.headers.get('request-id') ?? undefined;
  const contentRange = response.headers.get('content-range');
  const nextRange = response.headers.get('next-range');
  const pagination = parsePaginationMeta({ contentRange, nextRange });

  if (response.status === 304 && cached) {
    const success: ClientSuccess<T> = {
      ok: true,
      status: 304,
      body: cached.body as T,
      headers: extractHeaders(response.headers),
      cached: true,
    };
    if (requestId !== undefined) success.requestId = requestId;
    if (remaining !== undefined) success.rateLimitRemaining = remaining;
    if (pagination.hasMore || pagination.total !== undefined) success.pagination = pagination;
    return { kind: 'success', value: success };
  }

  const bodyText = await readBodyText(response);

  if (response.status >= 200 && response.status < 300) {
    const body = parseJson<T>(bodyText);

    if (canCache && etagCache) {
      const etag = response.headers.get('etag');
      if (etag) etagCache.store(method, url, etag, body);
    }

    const success: ClientSuccess<T> = {
      ok: true,
      status: response.status,
      body,
      headers: extractHeaders(response.headers),
      cached: false,
    };
    if (requestId !== undefined) success.requestId = requestId;
    if (remaining !== undefined) success.rateLimitRemaining = remaining;
    if (pagination.hasMore || pagination.total !== undefined) success.pagination = pagination;
    return { kind: 'success', value: success };
  }

  // Error response.
  const errorBody = parseJsonSafe(bodyText);
  const retryAfterMs = parseRetryAfterMs(response.headers);
  const mapInput: Parameters<typeof mapHttpResponseToError>[0] = {
    status: response.status,
    body: errorBody,
    url,
  };
  if (requestId !== undefined) mapInput.requestId = requestId;
  if (retryAfterMs !== undefined) mapInput.retryAfterMs = retryAfterMs;
  if (remaining !== undefined) mapInput.rateLimitRemaining = remaining;
  const error = mapHttpResponseToError(mapInput);
  const failure: Extract<ExecuteOutcome<T>, { kind: 'failure' }> = {
    kind: 'failure',
    error,
    status: response.status,
  };
  if (requestId !== undefined) failure.requestId = requestId;
  if (retryAfterMs !== undefined) failure.retryAfterMs = retryAfterMs;
  return failure;
}

function buildUrl(baseUrl: string, path: string, query: RequestOptions['query']): string {
  const url = /^https?:\/\//i.test(path) ? path : `${baseUrl}${ensureLeadingSlash(path)}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  if (!qs) return url;
  return url.includes('?') ? `${url}&${qs}` : `${url}?${qs}`;
}

function defaultIdempotency(method: string): boolean {
  return method === 'PATCH' || method === 'PUT' || method === 'DELETE';
}

function shouldRetry(
  method: string,
  status: number,
  retryAfterMs: number | undefined,
  idempotent: boolean,
): boolean {
  if (!RETRYABLE_STATUSES.has(status)) return false;
  if (method === 'GET' || method === 'HEAD') return true;
  if (method === 'POST') return retryAfterMs !== undefined;
  return idempotent;
}

function nextDelay(
  schedule: readonly number[],
  attempt: number,
  retryAfterMs: number | undefined,
): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) return retryAfterMs;
  const idx = Math.min(attempt - 1, schedule.length - 1);
  return schedule[idx] ?? 1000;
}

function parseNumericHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

function parseRetryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (raw === null) return undefined;
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds)) return seconds * 1000;
  // HTTP-date form: not implemented (rare for Heroku). Fall back to undefined.
  return undefined;
}

function extractHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of headers.entries()) {
    out[k.toLowerCase()] = v;
  }
  return out;
}

async function readBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function parseJson<T>(text: string): T {
  if (text.length === 0) return undefined as T;
  return JSON.parse(text) as T;
}

function parseJsonSafe(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || (err as { code?: string }).code === 'ABORT_ERR')
  );
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function ensureLeadingSlash(s: string): string {
  return s.startsWith('/') ? s : `/${s}`;
}

/** Re-export for callers that catch and want a quick type guard. */
export { isHerokuError };

const noopRelease: RateLimitRelease = () => undefined;
