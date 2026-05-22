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
    id: 'data.postgres_root',
    tier: 'data.postgres',
    method: 'HEAD',
    path: '/postgres',
    base: 'data',
    required: false,
    successCodes: [200, 204],
    emptyOkCodes: [],
    forbiddenCodes: [403, 404],
  },
  {
    id: 'data.redis_root',
    tier: 'data.redis',
    method: 'HEAD',
    path: '/redis',
    base: 'data',
    required: false,
    successCodes: [200, 204],
    emptyOkCodes: [],
    forbiddenCodes: [403, 404],
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

/** Substitute `${var}` placeholders in a path. Variables that aren't found in
 *  `vars` are left in place — the caller decides whether to treat that as an
 *  error or skip the probe. */
export function substitutePath(path: string, vars: Record<string, string>): string {
  return path.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (match, name: string) => {
    return vars[name] ?? match;
  });
}
