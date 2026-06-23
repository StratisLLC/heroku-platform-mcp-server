/**
 * Typed error hierarchy for `@heroku-mcp/core`.
 *
 * The single `kind` enum is the small set of switchable cases that tool
 * responses surface to MCP hosts (see ARCHITECTURE.md §8.5 and §12). Concrete
 * error classes carry richer context (HTTP status, Heroku error id, request
 * id, doc url, field names, retry hints) and a stable `kind` for callers that
 * don't care about subclass detail.
 *
 * Heroku error bodies follow the documented shape
 * `{ id, message, url? }` — see https://devcenter.heroku.com/articles/platform-api-reference#errors.
 */

/** Coarse, switchable error categories surfaced to tool callers. */
export type ErrorKind =
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'rate_limit'
  | 'delinquent'
  | 'invalid_params'
  | 'conflict'
  | 'server'
  | 'network'
  | 'confirmation';

/** Shape of a Heroku JSON error body. All fields optional because real-world
 *  failures may not parse (gateway returns HTML, server returns truncated JSON). */
export interface HerokuErrorBody {
  id?: string;
  message?: string;
  url?: string;
}

/** Tool-response envelope on failure (ARCHITECTURE.md §8.5). The `details`
 *  field carries kind-specific extras (e.g. `fields` for invalid_params) per
 *  §12; it is intentionally `unknown` because the schema is per-kind. */
export interface ToolErrorEnvelope {
  ok: false;
  error: {
    kind: ErrorKind;
    message: string;
    status?: number;
    herokuId?: string;
    requestId?: string;
    docUrl?: string;
    details?: unknown;
  };
}

/** Common construction options for {@link HerokuError}. */
export interface HerokuErrorOptions {
  status?: number;
  herokuId?: string;
  requestId?: string;
  docUrl?: string;
  url?: string;
  details?: unknown;
  cause?: unknown;
}

/**
 * Base class for every error originating in `@heroku-mcp/core`.
 *
 * Each concrete subclass sets a fixed {@link ErrorKind}. Subclasses must call
 * `super(message, opts)` and set their `name` in the constructor so that
 * stack traces and the `kind` discriminator survive serialisation.
 */
export abstract class HerokuError extends Error {
  /** Stable category used by MCP host clients. */
  public abstract readonly kind: ErrorKind;
  public readonly status?: number;
  public readonly herokuId?: string;
  public readonly requestId?: string;
  public readonly docUrl?: string;
  public readonly url?: string;
  public readonly details?: unknown;

  protected constructor(message: string, opts: HerokuErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.herokuId !== undefined) this.herokuId = opts.herokuId;
    if (opts.requestId !== undefined) this.requestId = opts.requestId;
    if (opts.docUrl !== undefined) this.docUrl = opts.docUrl;
    if (opts.url !== undefined) this.url = opts.url;
    if (opts.details !== undefined) this.details = opts.details;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** Render to the tool response envelope. */
  toToolEnvelope(): ToolErrorEnvelope {
    const error: ToolErrorEnvelope['error'] = {
      kind: this.kind,
      message: this.message,
    };
    if (this.status !== undefined) error.status = this.status;
    if (this.herokuId !== undefined) error.herokuId = this.herokuId;
    if (this.requestId !== undefined) error.requestId = this.requestId;
    if (this.docUrl !== undefined) error.docUrl = this.docUrl;
    if (this.details !== undefined) error.details = this.details;
    return { ok: false, error };
  }
}

/** 401: token invalid or missing. */
export class AuthError extends HerokuError {
  public readonly kind = 'auth' as const;
  constructor(message: string, opts?: HerokuErrorOptions) {
    super(message, opts);
    this.name = 'AuthError';
  }
}

/** 403: caller lacks access, or the resource is suspended. Account/app
 *  suspension is distinguished by `herokuId` ("suspended"). */
export class ForbiddenError extends HerokuError {
  public readonly kind = 'forbidden' as const;
  constructor(message: string, opts?: HerokuErrorOptions) {
    super(message, opts);
    this.name = 'ForbiddenError';
  }
}

/** 404: resource does not exist or is not visible to the caller. */
export class NotFoundError extends HerokuError {
  public readonly kind = 'not_found' as const;
  constructor(message: string, opts?: HerokuErrorOptions) {
    super(message, opts);
    this.name = 'NotFoundError';
  }
}

/** 402: the account is delinquent on payment. Tools that mutate are hidden
 *  while this is in effect; only diagnostic tools remain available. */
export class DelinquentError extends HerokuError {
  public readonly kind = 'delinquent' as const;
  constructor(message: string, opts?: HerokuErrorOptions) {
    super(message, opts);
    this.name = 'DelinquentError';
  }
}

/** Extra detail attached to a rate-limit error: the parsed `Retry-After`
 *  header value (when present) and the `RateLimit-Remaining` budget seen on
 *  the failing response. */
export interface RateLimitDetails {
  retryAfterMs?: number;
  remaining?: number;
}

/** 429: rate limit hit. */
export class RateLimitError extends HerokuError {
  public readonly kind = 'rate_limit' as const;
  public readonly retryAfterMs?: number;
  public readonly remaining?: number;

  constructor(message: string, opts?: HerokuErrorOptions & RateLimitDetails) {
    super(message, opts);
    this.name = 'RateLimitError';
    if (opts?.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
    if (opts?.remaining !== undefined) this.remaining = opts.remaining;
  }

  override toToolEnvelope(): ToolErrorEnvelope {
    const env = super.toToolEnvelope();
    const detail: RateLimitDetails = {};
    if (this.retryAfterMs !== undefined) detail.retryAfterMs = this.retryAfterMs;
    if (this.remaining !== undefined) detail.remaining = this.remaining;
    if (env.error.details === undefined && Object.keys(detail).length > 0) {
      env.error.details = detail;
    }
    return env;
  }
}

/** 400 / 422: parameters Heroku rejected. `fields` lists the field names
 *  Heroku flagged, when extractable from the response body. */
export class InvalidParamsError extends HerokuError {
  public readonly kind = 'invalid_params' as const;
  public readonly fields: readonly string[];

  constructor(message: string, opts?: HerokuErrorOptions & { fields?: readonly string[] }) {
    super(message, opts);
    this.name = 'InvalidParamsError';
    this.fields = opts?.fields ?? [];
  }

  override toToolEnvelope(): ToolErrorEnvelope {
    const env = super.toToolEnvelope();
    if (env.error.details === undefined && this.fields.length > 0) {
      env.error.details = { fields: [...this.fields] };
    }
    return env;
  }
}

/** 409: state conflict (e.g. concurrent ETag mismatch). */
export class ConflictError extends HerokuError {
  public readonly kind = 'conflict' as const;
  constructor(message: string, opts?: HerokuErrorOptions) {
    super(message, opts);
    this.name = 'ConflictError';
  }
}

/** 5xx: Heroku-side failure or gateway issue. */
export class ServerError extends HerokuError {
  public readonly kind = 'server' as const;
  constructor(message: string, opts?: HerokuErrorOptions) {
    super(message, opts);
    this.name = 'ServerError';
  }
}

/** Transport / network failure (DNS, TLS, connection reset, timeout). */
export class NetworkError extends HerokuError {
  public readonly kind = 'network' as const;
  public readonly timeoutMs?: number;

  constructor(message: string, opts?: HerokuErrorOptions & { timeoutMs?: number }) {
    super(message, opts);
    this.name = 'NetworkError';
    if (opts?.timeoutMs !== undefined) this.timeoutMs = opts.timeoutMs;
  }
}

/** A destructive tool's `confirm` parameter did not match the expected target. */
export class ConfirmationMismatchError extends HerokuError {
  public readonly kind = 'confirmation' as const;
  public readonly target: string;
  public readonly expected: string;
  public readonly received: string;

  constructor(target: string, expected: string, received: string) {
    super(
      `Confirmation mismatch for ${target}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(received)}. Pass the exact target name as the \`confirm\` parameter.`,
    );
    this.name = 'ConfirmationMismatchError';
    this.target = target;
    this.expected = expected;
    this.received = received;
  }

  override toToolEnvelope(): ToolErrorEnvelope {
    const env = super.toToolEnvelope();
    env.error.details = { target: this.target, expected: this.expected, received: this.received };
    return env;
  }
}

/**
 * Parse a Heroku JSON error body, tolerating malformed input. Returns a
 * partial body — callers should treat all fields as optional.
 */
export function parseHerokuErrorBody(body: unknown): HerokuErrorBody {
  if (typeof body !== 'object' || body === null) return {};
  const b = body as Record<string, unknown>;
  const out: HerokuErrorBody = {};
  if (typeof b.id === 'string') out.id = b.id;
  if (typeof b.message === 'string') out.message = b.message;
  if (typeof b.url === 'string') out.url = b.url;
  return out;
}

/** Inputs to {@link mapHttpResponseToError}. */
export interface MapResponseInput {
  status: number;
  body: unknown;
  url: string;
  requestId?: string;
  retryAfterMs?: number;
  rateLimitRemaining?: number;
  invalidParamsFields?: readonly string[];
}

/** Remediation appended to a 403 on a usage/billing endpoint. Scope alone is
 *  not sufficient — the Heroku user must also be a billing/enterprise admin. */
const USAGE_BILLING_403_REMEDIATION =
  'Usage and billing data require enterprise billing-admin permission on your Heroku account in ' +
  'addition to the `global` OAuth scope. A `global` token alone is not sufficient — if your ' +
  'Heroku user is not a billing/enterprise admin, this call will be forbidden.';

/** True when the request URL targets a usage or billing (invoices) endpoint.
 *  Used to attach a clearer 403 message for those tools only. Matches the
 *  Heroku paths `/teams|enterprise-accounts/{id}/usage/*` and `/account|teams
 *  /{id}/invoices`. */
function isUsageOrBillingUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.includes('usage') || lower.includes('invoices');
}

/**
 * Classify an HTTP error response into the appropriate {@link HerokuError}
 * subclass. The status is the primary signal; the body's `id` field
 * disambiguates (e.g. 403 + `id: "suspended"` becomes a ForbiddenError whose
 * `herokuId` carries that signal forward).
 */
export function mapHttpResponseToError(input: MapResponseInput): HerokuError {
  const body = parseHerokuErrorBody(input.body);
  const baseOpts: HerokuErrorOptions = {
    status: input.status,
    url: input.url,
  };
  if (body.id !== undefined) baseOpts.herokuId = body.id;
  if (body.url !== undefined) baseOpts.docUrl = body.url;
  if (input.requestId !== undefined) baseOpts.requestId = input.requestId;

  const message = body.message ?? defaultMessageForStatus(input.status);

  switch (input.status) {
    case 401:
      return new AuthError(message, baseOpts);
    case 402:
      return new DelinquentError(message, baseOpts);
    case 403:
      return new ForbiddenError(
        isUsageOrBillingUrl(input.url) ? `${message} ${USAGE_BILLING_403_REMEDIATION}` : message,
        baseOpts,
      );
    case 404:
      return new NotFoundError(message, baseOpts);
    case 409:
      return new ConflictError(message, baseOpts);
    case 422:
    case 400: {
      const opts: HerokuErrorOptions & { fields?: readonly string[] } = { ...baseOpts };
      if (input.invalidParamsFields !== undefined) opts.fields = input.invalidParamsFields;
      return new InvalidParamsError(message, opts);
    }
    case 429: {
      const opts: HerokuErrorOptions & RateLimitDetails = { ...baseOpts };
      if (input.retryAfterMs !== undefined) opts.retryAfterMs = input.retryAfterMs;
      if (input.rateLimitRemaining !== undefined) opts.remaining = input.rateLimitRemaining;
      return new RateLimitError(message, opts);
    }
    default:
      if (input.status >= 500) return new ServerError(message, baseOpts);
      // Any other 4xx falls through as invalid_params — the most actionable
      // default for a model that's building requests.
      return new InvalidParamsError(message, baseOpts);
  }
}

function defaultMessageForStatus(status: number): string {
  if (status === 401) return 'Authentication failed.';
  if (status === 402) return 'Account is delinquent on payment.';
  if (status === 403) return 'Forbidden.';
  if (status === 404) return 'Resource not found.';
  if (status === 409) return 'Conflict with current resource state.';
  if (status === 422 || status === 400) return 'Invalid parameters.';
  if (status === 429) return 'Rate limit exceeded.';
  if (status >= 500) return `Heroku returned ${status}.`;
  return `Request failed with status ${status}.`;
}

/** Type guard. */
export function isHerokuError(err: unknown): err is HerokuError {
  return err instanceof HerokuError;
}

/** Convert any thrown value into a tool-response envelope. Non-`HerokuError`
 *  throws are mapped to a generic `server` envelope so MCP hosts see a
 *  consistent shape. */
export function toToolEnvelope(err: unknown): ToolErrorEnvelope {
  if (isHerokuError(err)) return err.toToolEnvelope();
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { kind: 'server', message } };
}
