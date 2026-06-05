/**
 * Heroku Postgres API client helpers (thin wrappers over `@heroku-mcp/core`'s
 * {@link HerokuClient}).
 *
 * The Heroku Data API at `api.data.heroku.com` exposes TWO path prefixes on the
 * same host, with DIFFERENT auth schemes — this is the single most important
 * thing to get right:
 *
 *   - **`/client/v11/*` — Bearer auth** (same as the Platform API). Used for
 *     database info, app transfers (backups), transfer-schedules, maintenance.
 *     Build URLs with {@link dataUrl}; call with {@link getData}.
 *   - **`/postgres/v0/*` — HTTP Basic auth** (empty username, OAuth token as the
 *     password: `Basic base64(":" + token)`). Used for credentials. Build URLs
 *     with {@link pgV0Url}; call with {@link getDataBasic}. These endpoints take
 *     the database NAME or add-on UUID interchangeably.
 *
 * Operations modelled as add-on attributes (listing databases, the plan catalog)
 * stay on the **Platform API** (`api.heroku.com`) via `ctx.client` with normal
 * `/...` paths.
 *
 * The core client allows absolute URLs as long as the host is on its allowlist,
 * and `api.data.heroku.com` already is (see HEROKU_ALLOWED_HOSTS). It also lets
 * a per-request `Authorization` header override the default Bearer, which is how
 * {@link getDataBasic} swaps in the Basic scheme.
 *
 * The Data API speaks plain JSON rather than the versioned `vnd.heroku+json`
 * media type, so Data API requests override the `Accept` header.
 */

import { ForbiddenError, type ClientSuccess } from '@heroku-mcp/core';
import type { ToolContext } from '@heroku-mcp/platform';

/** Heroku Data API host. Already present in the core host allowlist. */
export const DATA_API_BASE = 'https://api.data.heroku.com';

/** Bearer-auth path prefix for the Data API (`/client/v11/*`). */
export const DATA_API_PREFIX = '/client/v11';

/** Basic-auth path prefix for the Data API (`/postgres/v0/*`). */
export const POSTGRES_V0_PREFIX = '/postgres/v0';

/** The Data API returns plain JSON; it does not negotiate the Platform API's
 *  `vnd.heroku+json` media type. */
export const DATA_API_ACCEPT = 'application/json';

/** URL-encode a single path segment (id or name). */
export const seg = (s: string): string => encodeURIComponent(s);

/** Build an absolute `/client/v11/*` (Bearer) Data API URL from a suffix. */
export function dataUrl(suffix: string): string {
  return `${DATA_API_BASE}${DATA_API_PREFIX}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
}

/** Build an absolute `/postgres/v0/*` (Basic) Data API URL from a suffix. */
export function pgV0Url(suffix: string): string {
  return `${DATA_API_BASE}${POSTGRES_V0_PREFIX}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
}

/** Construct the `/postgres/v0/*` HTTP Basic auth header value: an empty
 *  username with the OAuth token as the password. */
export async function basicAuthHeader(ctx: ToolContext): Promise<string> {
  const token = await Promise.resolve(ctx.token());
  return `Basic ${Buffer.from(`:${token}`).toString('base64')}`;
}

/** GET a `/client/v11/*` (Bearer) Data API endpoint, with a plain-JSON Accept. */
export function getData<T>(
  ctx: ToolContext,
  suffix: string,
  opts: { tool: string; headers?: Record<string, string> },
): Promise<ClientSuccess<T>> {
  return ctx.client.get<T>(dataUrl(suffix), {
    tool: opts.tool,
    headers: { Accept: DATA_API_ACCEPT, ...(opts.headers ?? {}) },
  });
}

/** GET a `/postgres/v0/*` (Basic) Data API endpoint. Overrides the client's
 *  default Bearer header with the Basic construction this namespace requires. */
export async function getDataBasic<T>(
  ctx: ToolContext,
  suffix: string,
  opts: { tool: string },
): Promise<ClientSuccess<T>> {
  const authorization = await basicAuthHeader(ctx);
  return ctx.client.get<T>(pgV0Url(suffix), {
    tool: opts.tool,
    headers: { Accept: DATA_API_ACCEPT, Authorization: authorization },
  });
}

/** The Postgres capability sub-tiers gated by {@link POSTGRES_PROBES}. */
export type PgFamily = 'pg_credentials' | 'pg_backups' | 'pg_followers' | 'pg_query_insights';

/**
 * Guard a Postgres tool family against its capability sub-tier.
 *
 * The whole package is gated on the `data.postgres` root tier at registration
 * time, so by the time a handler runs the database family is *probably*
 * reachable. The finer sub-tiers (from {@link POSTGRES_PROBES}) let us avoid a
 * round-trip that we already know will fail.
 *
 * Policy: only block when the sub-tier was *explicitly probed and found
 * unavailable*. If the sub-tier is absent (e.g. the extra probes were not run
 * in this deployment), we allow the call through and let the real Heroku
 * response speak for itself. This keeps the tools usable even when only the
 * Platform matrix was probed.
 */
export function assertFamilyAvailable(ctx: ToolContext, family: PgFamily, label: string): void {
  const data = ctx.getCapabilities().tiers.data as
    | Record<string, { available?: boolean; reason?: string; status?: number }>
    | undefined;
  const sub = data?.[family];
  if (sub?.available === false) {
    throw new ForbiddenError(
      `Heroku ${label} is not available for this token. The capability probe for "${family}" reported ${sub.reason ?? 'unavailable'}${
        sub.status ? ` (HTTP ${sub.status})` : ''
      }. This usually means the feature is not enabled on the database's plan, or the token lacks access.`,
      { details: { capability: family, reason: sub.reason, status: sub.status } },
    );
  }
}
