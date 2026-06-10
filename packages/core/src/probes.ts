/**
 * Probe matrix (CAPABILITY_PROBES.md).
 *
 * This module is data, not code: the prober walks the {@link PLATFORM_PROBES}
 * and {@link PARTNER_PROBES} arrays at startup, issues each {@link Probe} as
 * an HTTP request, and classifies the response into a tier outcome.
 *
 * Probes are intentionally tiny — most use a `Range` header (`id ..; max=1`)
 * so the server returns only the bare minimum. Total probe budget at startup
 * is ~15 requests, well under any rate limit.
 */

/** Where to find this probe — selects the base URL the prober dials. */
export type ProbeBase = 'platform' | 'data' | 'addons';

/** Identifies the tier each probe gates. Free-form string so partner add-ons
 *  can stand up custom tiers without changing this file. */
export type TierName = string;

/** Single probe definition. */
export interface Probe {
  /** Stable identifier; used as a cache key and in result files. */
  id: string;
  /** The tier this probe is the gate for (e.g. `"apps"`, `"data.postgres"`). */
  tier: TierName;
  /** All probes are safe (read-only). HEAD is allowed for HEAD-only endpoints. */
  method: 'GET' | 'HEAD';
  /** Path under the chosen base. Supports `${var}` substitution. */
  path: string;
  /** Which host to dial. */
  base: ProbeBase;
  /** If true, the server refuses to start without this tier. */
  required: boolean;
  /** Status codes that mean "tier available". */
  successCodes: readonly number[];
  /** Status codes that mean "tier available but empty". */
  emptyOkCodes: readonly number[];
  /** Status codes that mean "tier unavailable for this caller". */
  forbiddenCodes: readonly number[];
  /** Optional `Range` header to keep responses small. */
  range?: string;
  /** Another probe's id that must succeed first (or this probe is skipped). */
  dependsOn?: string;
  /** True if this probe belongs to the Partner MCP rather than the Platform MCP. */
  partner?: boolean;
  /** True if the probe uses manifest Basic auth instead of OAuth bearer. */
  manifestAuth?: boolean;
  /**
   * How to authenticate this probe. Defaults to `'bearer'` (`Authorization:
   * Bearer <token>`). Set to `'basic'` for Heroku Data API endpoints under
   * `/postgres/v0/*`, which take HTTP Basic auth with an empty username and the
   * OAuth token as the password (`Basic base64(":" + token)`). Ignored when
   * {@link manifestAuth} is set (manifest Basic auth takes precedence).
   */
  authScheme?: 'bearer' | 'basic';
}

/** Default `Range` value used by every "list" probe. */
export const PROBE_RANGE_DEFAULT = 'id ..; max=1';

/** Default tier outcome codes. */
const SUCCESS = [200, 206];
const EMPTY_OK = [404];
const FORBIDDEN = [402, 403];

/** Common Platform probes. CAPABILITY_PROBES.md "Tiers and probes — Platform MCP". */
export const PLATFORM_PROBES: readonly Probe[] = Object.freeze([
  // ---- account ----
  {
    id: 'account.self',
    tier: 'account',
    method: 'GET',
    path: '/account',
    base: 'platform',
    required: true,
    successCodes: [200],
    emptyOkCodes: [],
    forbiddenCodes: [],
  },
  {
    id: 'account.rate_limit',
    tier: 'account',
    method: 'GET',
    path: '/account/rate-limits',
    base: 'platform',
    required: false,
    successCodes: [200],
    emptyOkCodes: [],
    forbiddenCodes: [],
  },

  // ---- apps ----
  {
    id: 'apps.list',
    tier: 'apps',
    method: 'GET',
    path: '/apps',
    base: 'platform',
    required: false,
    successCodes: SUCCESS,
    emptyOkCodes: EMPTY_OK,
    forbiddenCodes: FORBIDDEN,
    range: PROBE_RANGE_DEFAULT,
  },
  {
    id: 'apps.list_owned',
    tier: 'apps',
    method: 'GET',
    path: '/users/~/apps',
    base: 'platform',
    required: false,
    successCodes: SUCCESS,
    emptyOkCodes: EMPTY_OK,
    forbiddenCodes: FORBIDDEN,
    range: PROBE_RANGE_DEFAULT,
  },

  // ---- teams ----
  {
    id: 'teams.list',
    tier: 'teams',
    method: 'GET',
    path: '/teams',
    base: 'platform',
    required: false,
    successCodes: SUCCESS,
    emptyOkCodes: EMPTY_OK,
    forbiddenCodes: FORBIDDEN,
    range: PROBE_RANGE_DEFAULT,
  },

  // ---- enterprise ----
  {
    id: 'enterprise.list',
    tier: 'enterprise',
    method: 'GET',
    path: '/enterprise-accounts',
    base: 'platform',
    required: false,
    successCodes: SUCCESS,
    emptyOkCodes: EMPTY_OK,
    forbiddenCodes: FORBIDDEN,
    range: PROBE_RANGE_DEFAULT,
  },

  // ---- spaces ----
  {
    id: 'spaces.list',
    tier: 'spaces',
    method: 'GET',
    path: '/spaces',
    base: 'platform',
    required: false,
    successCodes: SUCCESS,
    emptyOkCodes: EMPTY_OK,
    forbiddenCodes: FORBIDDEN,
    range: PROBE_RANGE_DEFAULT,
  },

  // ---- addons_consumer ----
  {
    id: 'addons.list',
    tier: 'addons_consumer',
    method: 'GET',
    path: '/addons',
    base: 'platform',
    required: false,
    successCodes: SUCCESS,
    emptyOkCodes: EMPTY_OK,
    forbiddenCodes: FORBIDDEN,
    range: PROBE_RANGE_DEFAULT,
  },
  {
    id: 'addons.services_list',
    tier: 'addons_consumer',
    method: 'GET',
    path: '/addon-services',
    base: 'platform',
    required: false,
    successCodes: SUCCESS,
    emptyOkCodes: [],
    forbiddenCodes: FORBIDDEN,
    range: PROBE_RANGE_DEFAULT,
  },
  {
    id: 'addons.plans_list',
    tier: 'addons_consumer',
    method: 'GET',
    path: '/addon-services/heroku-postgresql/plans',
    base: 'platform',
    required: false,
    successCodes: SUCCESS,
    emptyOkCodes: [],
    forbiddenCodes: FORBIDDEN,
    range: PROBE_RANGE_DEFAULT,
  },

  // ---- pipelines ----
  {
    id: 'pipelines.list',
    tier: 'pipelines',
    method: 'GET',
    path: '/pipelines',
    base: 'platform',
    required: false,
    successCodes: SUCCESS,
    emptyOkCodes: EMPTY_OK,
    forbiddenCodes: FORBIDDEN,
    range: PROBE_RANGE_DEFAULT,
  },

  // ---- data ----
  {
    // The Heroku Data API has no probeable "root": `HEAD /postgres` returns 404
    // because no such resource exists. Instead we GET a deliberately-nonexistent
    // database UUID under the real `/client/v11/databases/{id}` path. A 404 means
    // "endpoint reachable + auth accepted, no such DB" → the tier is available.
    // A 401/402/403 means the token can't reach the Data API at all.
    id: 'data.postgres_root',
    tier: 'data.postgres',
    method: 'GET',
    path: '/client/v11/databases/00000000-0000-0000-0000-000000000000',
    base: 'data',
    required: false,
    successCodes: [200, 204, 404], // 404 = reachable, no such DB = OK
    emptyOkCodes: [],
    forbiddenCodes: [401, 402, 403], // unauthorized / payment required / forbidden
  },
  {
    // Like Postgres, the Heroku Data API has no probeable Key-Value "root":
    // `HEAD /redis` returns 404 (no such resource), which the old probe
    // mis-classified as forbidden — marking the tier unavailable and hiding
    // every Key-Value tool. Instead we GET a deliberately-nonexistent database
    // UUID under the real `/redis/v0/databases/{id}` namespace the tools use,
    // with the same HTTP Basic auth (empty user, OAuth token as password). A
    // 404 means "endpoint reachable + auth accepted, no such DB" → the tier is
    // available; a 401/402/403 means the token can't reach the Key-Value Data
    // API at all. Verified live 2026-06-10: `HEAD /redis` → 404 (would read as
    // forbidden), `GET /redis/v0/databases/{zero-uuid}` → 404 with both Bearer
    // and Basic.
    id: 'data.redis_root',
    tier: 'data.redis',
    method: 'GET',
    path: '/redis/v0/databases/00000000-0000-0000-0000-000000000000',
    base: 'data',
    authScheme: 'basic',
    required: false,
    successCodes: [200, 204, 404],
    emptyOkCodes: [],
    forbiddenCodes: [401, 402, 403],
  },
  {
    id: 'data.kafka_root',
    tier: 'data.kafka',
    method: 'HEAD',
    path: '/data/kafka',
    base: 'data',
    required: false,
    successCodes: [200, 204],
    emptyOkCodes: [],
    forbiddenCodes: [403, 404],
  },
]);

/** Common Partner probes. CAPABILITY_PROBES.md "Tiers and probes — Partner MCP".
 *  Per-token probes (`partner.addon_info` etc.) substitute `${resource_uuid}` /
 *  `${team_id}` at probe time. */
export const PARTNER_PROBES: readonly Probe[] = Object.freeze([
  {
    id: 'partner.addon_info',
    tier: 'partner.oauth_basic',
    method: 'GET',
    path: '/addons/${resource_uuid}',
    base: 'platform',
    required: true,
    successCodes: [200],
    emptyOkCodes: [],
    forbiddenCodes: [401, 403, 404],
    partner: true,
  },
  {
    id: 'partner.pipelines_list',
    tier: 'partner.pipelines',
    method: 'GET',
    path: '/pipelines',
    base: 'platform',
    required: false,
    successCodes: SUCCESS,
    emptyOkCodes: EMPTY_OK,
    forbiddenCodes: FORBIDDEN,
    range: PROBE_RANGE_DEFAULT,
    partner: true,
  },
  {
    id: 'partner.team_members_list',
    tier: 'partner.team_members',
    method: 'GET',
    path: '/teams/${team_id}/members',
    base: 'platform',
    required: false,
    successCodes: SUCCESS,
    emptyOkCodes: EMPTY_OK,
    forbiddenCodes: FORBIDDEN,
    range: PROBE_RANGE_DEFAULT,
    partner: true,
    dependsOn: 'partner.addon_info',
  },
  {
    id: 'partner.installs_list',
    tier: 'partner.manifest',
    method: 'GET',
    path: '/api/v3/apps',
    base: 'addons',
    required: false,
    successCodes: SUCCESS,
    emptyOkCodes: EMPTY_OK,
    forbiddenCodes: FORBIDDEN,
    range: PROBE_RANGE_DEFAULT,
    partner: true,
    manifestAuth: true,
  },
]);

/**
 * Heroku Postgres probes (Phase 6 Part A).
 *
 * The Postgres-specific endpoint families live under the Heroku Data API
 * (`api.data.heroku.com/client/v11/...`), which is the `data` base. Unlike the
 * Platform API list probes, we cannot enumerate a real database without knowing
 * a UUID, so each probe dials a deliberately-nonexistent database id and treats
 * a `404` as "endpoint reachable + auth accepted" (the family is available). A
 * `403`/`402` means the caller's token or plan cannot reach the family.
 *
 * These probes are additive: the package-level gate is the existing
 * `data.postgres` root tier (see {@link PLATFORM_PROBES}). The sub-tiers below
 * let individual tool families (backups, followers, credentials, query
 * insights) detect availability without blindly calling the endpoint. Tools
 * whose sub-tier was probed and came back unavailable return a structured
 * "capability not available" envelope rather than issuing the request.
 *
 * Sub-tiers are namespaced under `data.` so they nest in the capability result
 * the same way `data.postgres`/`data.redis`/`data.kafka` do.
 */
const PG_PROBE_DB_ID = '00000000-0000-0000-0000-000000000000';

export const POSTGRES_PROBES: readonly Probe[] = Object.freeze([
  {
    // Credentials live under the `/postgres/v0/*` namespace, which is HTTP Basic
    // auth (empty user, OAuth token as password) — NOT Bearer like `/client/v11`.
    // A nonexistent DB returns 404 here ("reachable, no such DB" = available).
    id: 'pg.api.credentials',
    tier: 'data.pg_credentials',
    method: 'GET',
    path: `/postgres/v0/databases/${PG_PROBE_DB_ID}/credentials`,
    base: 'data',
    authScheme: 'basic',
    required: false,
    successCodes: SUCCESS,
    emptyOkCodes: EMPTY_OK,
    forbiddenCodes: FORBIDDEN,
    dependsOn: 'data.postgres_root',
  },
  {
    id: 'pg.api.backups',
    tier: 'data.pg_backups',
    method: 'GET',
    path: `/client/v11/databases/${PG_PROBE_DB_ID}/backups`,
    base: 'data',
    required: false,
    successCodes: SUCCESS,
    emptyOkCodes: EMPTY_OK,
    forbiddenCodes: FORBIDDEN,
    dependsOn: 'data.postgres_root',
  },
  {
    id: 'pg.api.followers',
    tier: 'data.pg_followers',
    method: 'GET',
    path: `/client/v11/databases/${PG_PROBE_DB_ID}/followers`,
    base: 'data',
    required: false,
    successCodes: SUCCESS,
    emptyOkCodes: EMPTY_OK,
    forbiddenCodes: FORBIDDEN,
    dependsOn: 'data.postgres_root',
  },
  {
    id: 'pg.api.query_insights',
    tier: 'data.pg_query_insights',
    method: 'GET',
    path: `/client/v11/databases/${PG_PROBE_DB_ID}/query-stats`,
    base: 'data',
    required: false,
    // 404 here is ambiguous: it can mean "endpoint reachable, db not found"
    // (feature available) OR "feature not enabled on this plan". We optimistically
    // treat 404 as reachable; the tool surfaces an actionable error at call time
    // if query insights turns out to be disabled. A 402/403 is an unambiguous
    // "gated" signal and marks the sub-tier unavailable.
    successCodes: SUCCESS,
    emptyOkCodes: EMPTY_OK,
    forbiddenCodes: FORBIDDEN,
    dependsOn: 'data.postgres_root',
  },
]);

/**
 * Heroku Key-Value Store (Redis) probes (Key-Value Part A).
 *
 * Mirrors {@link POSTGRES_PROBES}: the package-level gate is the `data.redis`
 * root tier (see {@link PLATFORM_PROBES}'s `data.redis_root`), and the sub-tier
 * below lets the config-mutation tool family detect availability without
 * blindly calling the endpoint. All Key-Value Data API endpoints live under the
 * `/redis/v0/*` namespace, which takes HTTP Basic auth (empty username, OAuth
 * token as password) — NOT Bearer. A deliberately-nonexistent database id
 * returns 404 ("reachable, no such DB" = available); a 402/403 is "gated".
 *
 * NOTE: there is no separate credentials sub-probe. Unlike Postgres, the
 * Heroku CLI's `redis:credentials` reads the connection URL straight out of the
 * `GET /redis/v0/databases/{id}` info body (there is no `/credentials`
 * sub-resource), so credentials reachability is already covered by the
 * `data.redis_root` probe. Verified live 2026-06-10.
 */
const KV_PROBE_DB_ID = '00000000-0000-0000-0000-000000000000';

export const KEYVALUE_PROBES: readonly Probe[] = Object.freeze([
  {
    // Config reads/writes (maxmemory policy, idle timeout, keyspace
    // notifications) hit `/redis/v0/databases/{id}/config`. Basic auth, same as
    // the root. A nonexistent DB returns 404 here ("reachable" = available).
    id: 'kv.api.config',
    tier: 'data.kv_config',
    method: 'GET',
    path: `/redis/v0/databases/${KV_PROBE_DB_ID}/config`,
    base: 'data',
    authScheme: 'basic',
    required: false,
    successCodes: SUCCESS,
    emptyOkCodes: EMPTY_OK,
    forbiddenCodes: FORBIDDEN,
    dependsOn: 'data.redis_root',
  },
]);

/** Substitute `${var}` placeholders in a path. Variables that aren't found in
 *  `vars` are left in place — the caller decides whether to treat that as an
 *  error or skip the probe. */
export function substitutePath(path: string, vars: Record<string, string>): string {
  return path.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (match, name: string) => {
    return vars[name] ?? match;
  });
}
