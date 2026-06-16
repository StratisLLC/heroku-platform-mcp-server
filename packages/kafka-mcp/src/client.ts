/**
 * Heroku Apache Kafka API client helpers (thin wrappers over `@heroku-mcp/core`'s
 * {@link HerokuClient}). Mirrors `@heroku-mcp/key-value`'s client.ts.
 *
 * The Heroku Data API at `api.data.heroku.com` exposes the Kafka control plane
 * under a single path prefix:
 *
 *   - **`/data/kafka/v0/clusters/{cluster_uuid}/*` — HTTP Basic auth** (empty
 *     username, OAuth token as the password: `Basic base64(":" + token)`). Used
 *     for cluster info, topics and consumer groups. Build URLs with
 *     {@link kafkaV0Url} / {@link clusterUrl}; call with {@link getDataBasic}.
 *
 *     NAMESPACE NOTE: unlike Key-Value's `/redis/v0/*`, the Kafka control plane
 *     KEEPS the `/data` prefix (`/data/kafka/v0/*`). Verified live 2026-06-10.
 *
 *     ID NOTE: cluster endpoints are addressed by the add-on UUID, NOT the
 *     add-on name — the name returns 404 (verified live 2026-06-10). See
 *     {@link resolveClusterId}.
 *
 *     AUTH NOTE: the Heroku CLI (`heroku/cli` `src/lib/kafka/*`) talks to this
 *     namespace and verified live both Bearer and Basic return 200. We use Basic
 *     for symmetry with `@heroku-mcp/postgres` and `@heroku-mcp/key-value` and
 *     to honour the two-auth Data API model the core `Probe.authScheme`
 *     machinery is built around. Verified live 2026-06-10.
 *
 * Operations modelled as add-on attributes (listing Kafka add-ons across the
 * account) stay on the **Platform API** (`api.heroku.com`) via `ctx.client`
 * with normal `/...` paths.
 *
 * The core client allows absolute URLs as long as the host is on its allowlist,
 * and `api.data.heroku.com` already is. It also lets a per-request
 * `Authorization` header override the default Bearer, which is how the Basic
 * helper swaps in the Basic scheme. The Data API speaks plain JSON rather than
 * the versioned `vnd.heroku+json` media type, so Data API requests override the
 * `Accept` header.
 */

import { ForbiddenError, type ClientSuccess } from '@heroku-mcp/core';
import type { ToolContext } from '@heroku-mcp/core';

/** Heroku Data API host. Already present in the core host allowlist. */
export const DATA_API_BASE = 'https://api.data.heroku.com';

/** Basic-auth path prefix for the Kafka Data API (`/data/kafka/v0/*`). */
export const KAFKA_V0_PREFIX = '/data/kafka/v0';

/** The Data API returns plain JSON; it does not negotiate the Platform API's
 *  `vnd.heroku+json` media type. */
export const DATA_API_ACCEPT = 'application/json';

/** URL-encode a single path segment (id or name). */
export const seg = (s: string): string => encodeURIComponent(s);

/** Build an absolute `/data/kafka/v0/*` (Basic) Data API URL from a suffix. */
export function kafkaV0Url(suffix: string): string {
  return `${DATA_API_BASE}${KAFKA_V0_PREFIX}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
}

/** Build an absolute cluster-scoped Data API URL:
 *  `/data/kafka/v0/clusters/{clusterId}{suffix}`. `clusterId` MUST be the add-on
 *  UUID (see {@link resolveClusterId}); `suffix` is `''` for the cluster itself,
 *  or `/topics` / `/consumer_groups` for the sub-resources. */
export function clusterUrl(clusterId: string, suffix = ''): string {
  return kafkaV0Url(`/clusters/${seg(clusterId)}${suffix}`);
}

/** Construct the `/data/kafka/v0/*` HTTP Basic auth header value: an empty
 *  username with the OAuth token as the password. */
export async function basicAuthHeader(ctx: ToolContext): Promise<string> {
  const token = await Promise.resolve(ctx.token());
  return `Basic ${Buffer.from(`:${token}`).toString('base64')}`;
}

/** GET a `/data/kafka/v0/*` (Basic) Data API endpoint. Overrides the client's
 *  default Bearer header with the Basic construction this namespace uses. */
export async function getDataBasic<T>(
  ctx: ToolContext,
  url: string,
  opts: { tool: string },
): Promise<ClientSuccess<T>> {
  const authorization = await basicAuthHeader(ctx);
  return ctx.client.get<T>(url, {
    tool: opts.tool,
    headers: { Accept: DATA_API_ACCEPT, Authorization: authorization },
  });
}

/** The Kafka capability sub-tiers gated by {@link KAFKA_PROBES}. */
export type KafkaFamily = 'kafka_topics' | 'kafka_consumer_groups';

/**
 * Guard a Kafka tool family against its capability sub-tier.
 *
 * The whole package is gated on the `data.kafka` root tier at registration
 * time, so by the time a handler runs the Kafka Data API is *probably*
 * reachable. The finer sub-tiers (from {@link KAFKA_PROBES}) let us avoid a
 * round-trip that we already know will fail.
 *
 * Policy (identical to `@heroku-mcp/key-value`'s `assertFamilyAvailable`): only
 * block when the sub-tier was *explicitly probed and found unavailable*. If the
 * sub-tier is absent (e.g. the extra probes were not run in this deployment),
 * we allow the call through and let the real Heroku response speak for itself.
 */
export function assertFamilyAvailable(ctx: ToolContext, family: KafkaFamily, label: string): void {
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
