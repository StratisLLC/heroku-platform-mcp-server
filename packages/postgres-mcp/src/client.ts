/**
 * Heroku Postgres API client helpers (thin wrappers over `@heroku-mcp/core`'s
 * {@link HerokuClient}).
 *
 * Postgres operations split across two hosts:
 *
 *   - The **Platform API** (`api.heroku.com`) for things modelled as add-on
 *     attributes — listing a database (an add-on), its plan catalog. These go
 *     straight through `ctx.client` with normal `/...` paths.
 *   - The **Heroku Data API** (`api.data.heroku.com/client/v11/...`) for
 *     Postgres-specific families — credentials, backups, followers, query
 *     insights. These use {@link dataUrl} to build an absolute URL. The core
 *     client allows absolute URLs as long as the host is on its allowlist, and
 *     `api.data.heroku.com` already is (see HEROKU_ALLOWED_HOSTS).
 *
 * Both hosts authenticate with the same Heroku OAuth bearer token the core
 * client already carries — there is no separate auth flow.
 *
 * The Data API speaks plain JSON rather than the versioned `vnd.heroku+json`
 * media type, so Data API requests override the `Accept` header.
 */

import { ForbiddenError, type ClientSuccess } from '@heroku-mcp/core';
import type { ToolContext } from '@heroku-mcp/platform';

/** Heroku Data API host. Already present in the core host allowlist. */
export const DATA_API_BASE = 'https://api.data.heroku.com';

/** Versioned path prefix for the Data API. */
export const DATA_API_PREFIX = '/client/v11';

/** The Data API returns plain JSON; it does not negotiate the Platform API's
 *  `vnd.heroku+json` media type. */
export const DATA_API_ACCEPT = 'application/json';

/** URL-encode a single path segment (id or name). */
export const seg = (s: string): string => encodeURIComponent(s);

/** Build an absolute Data API URL from a `/databases/...`-style suffix. */
export function dataUrl(suffix: string): string {
  return `${DATA_API_BASE}${DATA_API_PREFIX}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
}

/** GET a Data API endpoint, overriding the Accept header to plain JSON. */
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
