/**
 * Heroku Key-Value Store (Redis) API client helpers (thin wrappers over
 * `@heroku-mcp/core`'s {@link HerokuClient}). Mirrors
 * `@heroku-mcp/postgres`'s client.ts.
 *
 * The Heroku Data API at `api.data.heroku.com` exposes the Key-Value control
 * plane under a single path prefix:
 *
 *   - **`/redis/v0/*` — HTTP Basic auth** (empty username, OAuth token as the
 *     password: `Basic base64(":" + token)`). Used for info, credentials,
 *     config, stats-reset and credential rotation. Build URLs with
 *     {@link redisV0Url}; call with {@link getDataBasic} / {@link patchDataBasic}
 *     / {@link postDataBasic}. These endpoints take the database NAME or add-on
 *     UUID interchangeably.
 *
 *     AUTH NOTE: the Heroku CLI (`lib/redis/api.js`) actually talks to this
 *     namespace with the default Bearer token, and verified live both Bearer
 *     and Basic return 200. We use Basic for symmetry with `@heroku-mcp/postgres`
 *     and to honour the two-auth Data API model the core `Probe.authScheme`
 *     machinery is built around. Verified live 2026-06-10.
 *
 * Operations modelled as add-on attributes (listing Key-Value add-ons across
 * the account) stay on the **Platform API** (`api.heroku.com`) via `ctx.client`
 * with normal `/...` paths.
 *
 * The core client allows absolute URLs as long as the host is on its allowlist,
 * and `api.data.heroku.com` already is. It also lets a per-request
 * `Authorization` header override the default Bearer, which is how the Basic
 * helpers swap in the Basic scheme. The Data API speaks plain JSON rather than
 * the versioned `vnd.heroku+json` media type, so Data API requests override the
 * `Accept` header.
 */

import { ForbiddenError, type ClientSuccess } from '@heroku-mcp/core';
import type { ToolContext } from '@heroku-mcp/platform';

/** Heroku Data API host. Already present in the core host allowlist. */
export const DATA_API_BASE = 'https://api.data.heroku.com';

/** Basic-auth path prefix for the Key-Value Data API (`/redis/v0/*`). */
export const REDIS_V0_PREFIX = '/redis/v0';

/** The Data API returns plain JSON; it does not negotiate the Platform API's
 *  `vnd.heroku+json` media type. */
export const DATA_API_ACCEPT = 'application/json';

/** URL-encode a single path segment (id or name). */
export const seg = (s: string): string => encodeURIComponent(s);

/** Build an absolute `/redis/v0/*` (Basic) Data API URL from a suffix. */
export function redisV0Url(suffix: string): string {
  return `${DATA_API_BASE}${REDIS_V0_PREFIX}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
}

/** Construct the `/redis/v0/*` HTTP Basic auth header value: an empty username
 *  with the OAuth token as the password. */
export async function basicAuthHeader(ctx: ToolContext): Promise<string> {
  const token = await Promise.resolve(ctx.token());
  return `Basic ${Buffer.from(`:${token}`).toString('base64')}`;
}

/** GET a `/redis/v0/*` (Basic) Data API endpoint. Overrides the client's
 *  default Bearer header with the Basic construction this namespace uses. */
export async function getDataBasic<T>(
  ctx: ToolContext,
  suffix: string,
  opts: { tool: string },
): Promise<ClientSuccess<T>> {
  const authorization = await basicAuthHeader(ctx);
  return ctx.client.get<T>(redisV0Url(suffix), {
    tool: opts.tool,
    headers: { Accept: DATA_API_ACCEPT, Authorization: authorization },
  });
}

/** POST a `/redis/v0/*` (Basic) Data API endpoint. `body` is omitted from the
 *  wire when undefined; the Key-Value writes send an explicit empty `{}`. */
export async function postDataBasic<T>(
  ctx: ToolContext,
  suffix: string,
  body: unknown,
  opts: { tool: string },
): Promise<ClientSuccess<T>> {
  const authorization = await basicAuthHeader(ctx);
  return ctx.client.request<T>({
    path: redisV0Url(suffix),
    method: 'POST',
    body: body ?? null,
    tool: opts.tool,
    headers: { Accept: DATA_API_ACCEPT, Authorization: authorization },
  });
}

/** PATCH a `/redis/v0/*` (Basic) Data API endpoint. Used by the config writes,
 *  which the CLI issues as `PATCH /redis/v0/databases/{id}/config`. */
export async function patchDataBasic<T>(
  ctx: ToolContext,
  suffix: string,
  body: unknown,
  opts: { tool: string },
): Promise<ClientSuccess<T>> {
  const authorization = await basicAuthHeader(ctx);
  return ctx.client.request<T>({
    path: redisV0Url(suffix),
    method: 'PATCH',
    body: body ?? null,
    tool: opts.tool,
    headers: { Accept: DATA_API_ACCEPT, Authorization: authorization },
  });
}

/** The Key-Value capability sub-tiers gated by {@link KEYVALUE_PROBES}. */
export type KvFamily = 'kv_config';

/**
 * Guard a Key-Value tool family against its capability sub-tier.
 *
 * The whole package is gated on the `data.redis` root tier at registration
 * time, so by the time a handler runs the Key-Value Data API is *probably*
 * reachable. The finer sub-tiers (from {@link KEYVALUE_PROBES}) let us avoid a
 * round-trip that we already know will fail.
 *
 * Policy (identical to `@heroku-mcp/postgres`'s `assertFamilyAvailable`): only
 * block when the sub-tier was *explicitly probed and found unavailable*. If the
 * sub-tier is absent (e.g. the extra probes were not run in this deployment),
 * we allow the call through and let the real Heroku response speak for itself.
 */
export function assertFamilyAvailable(ctx: ToolContext, family: KvFamily, label: string): void {
  const data = ctx.getCapabilities().tiers.data as
    | Record<string, { available?: boolean; reason?: string; status?: number }>
    | undefined;
  const sub = data?.[family];
  if (sub?.available === false) {
    throw new ForbiddenError(
      `Heroku ${label} is not available for this token. The capability probe for "${family}" reported ${sub.reason ?? 'unavailable'}${
        sub.status ? ` (HTTP ${sub.status})` : ''
      }. This usually means the feature is not enabled on the add-on's plan, or the token lacks access.`,
      { details: { capability: family, reason: sub.reason, status: sub.status } },
    );
  }
}
