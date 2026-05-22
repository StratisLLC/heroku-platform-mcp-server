# Heroku MCP — Capability Probe Matrix

> Defines exactly which GET requests the prober issues on startup and how each result maps to a tool tier. Implements §5 of `ARCHITECTURE.md`.

## Probe contract

Each probe is an object:

```ts
interface Probe {
  id: string;                    // stable identifier, also used as cache key
  tier: TierName;                // which tier this probe gates
  method: 'GET';                 // probes are always GET — never mutate
  path: string;                  // path relative to base; supports ${var}
  base: 'platform' | 'data' | 'addons';  // which host
  required: boolean;             // if true, server refuses to start without this tier
  successCodes: number[];        // codes that mean "tier available"
  emptyOkCodes: number[];        // codes that mean "tier available but empty"
  forbiddenCodes: number[];      // codes that mean "tier unavailable to this caller"
  range?: string;                // optional Range header to keep response tiny
  dependsOn?: string;            // another probe whose ID must succeed first
  partner?: boolean;             // probe is for the Partner MCP, not Platform
}
```

**Hosts:**
- `platform` → `https://api.heroku.com`
- `data` → `https://api.data.heroku.com`
- `addons` → `https://addons.heroku.com` (Partner-only, manifest auth)

**Default Range:** `id ..; max=1` — we only need to know "can I read this", not the contents. Probes return ~100 bytes each.

## Tiers and probes — Platform MCP

### Tier: `account` (always required)

| ID | Path | Notes |
|---|---|---|
| `account.self` | `/account` | If this 401s, the server exits. |
| `account.rate_limit` | `/account/rate-limits` | Confirms rate-limit endpoint reachable; doesn't count against limit. |

If `account.self` returns 402 (delinquent) or 403 (suspended), the server starts in **diagnostic mode**: only `whoami`, `account_info`, `rate_limit_status`, `audit_tail`, `refresh_capabilities` are exposed.

### Tier: `apps`

| ID | Path | Notes |
|---|---|---|
| `apps.list` | `/apps` | `Range: id ..; max=1` |
| `apps.list_owned` | `/users/~/apps` | `~` is a Heroku alias for the authenticated user |

Lights up: app CRUD, config vars, formation, dynos, releases, builds, slugs, domains, SNI endpoints, log sessions, log drains, app webhooks, app transfers, app features, app setup, review apps, source, OCI images.

### Tier: `teams`

| ID | Path | Notes |
|---|---|---|
| `teams.list` | `/teams` | `Range: id ..; max=1` |

Lights up: team CRUD, team members, team apps, team invitations, team invoices, team daily/monthly usage, team features, team add-ons, team app permissions, team app collaborators, team preferences, team spaces, team delinquency.

### Tier: `enterprise`

| ID | Path | Notes |
|---|---|---|
| `enterprise.list` | `/enterprise-accounts` | `Range: id ..; max=1` |

Lights up: enterprise account info, enterprise members, enterprise daily/monthly usage, permission entities, identity providers, audit trail events, audit trail archives.

### Tier: `spaces`

| ID | Path | Notes |
|---|---|---|
| `spaces.list` | `/spaces` | `Range: id ..; max=1`. Spaces are an Enterprise-only feature; this tier will 403 for most accounts. |

Lights up: spaces CRUD, space access, space topology, peering, peering info, inbound rulesets, VPN connections, space NAT, space transfer.

### Tier: `addons_consumer`

| ID | Path | Notes |
|---|---|---|
| `addons.list` | `/addons` | `Range: id ..; max=1` |
| `addons.services_list` | `/addon-services` | Static catalog; doesn't require account access but confirms reachability. |
| `addons.plans_list` | `/addon-services/heroku-postgresql/plans` | Sanity check; if this 404s the catalog is broken upstream. |

Lights up: add-on CRUD, add-on attachments, add-on services, plans, add-on webhooks, add-on actions (consumer side), allowed add-on services.

### Tier: `pipelines`

| ID | Path | Notes |
|---|---|---|
| `pipelines.list` | `/pipelines` | `Range: id ..; max=1` |

Lights up: pipelines CRUD, pipeline couplings, pipeline builds, pipeline config vars, pipeline deployments, pipeline promotions, pipeline releases, pipeline stacks, pipeline transfers.

### Tier: `data`

The data APIs live at `api.data.heroku.com` and are typically scoped to a specific add-on resource. Probing them generically is awkward — there's no top-level "list" endpoint. Strategy:

| ID | Path | Notes |
|---|---|---|
| `data.postgres_root` | `/postgres` (HEAD) | If a Postgres add-on exists in scope, this returns 200; otherwise 404. |
| `data.redis_root` | `/redis` (HEAD) | Same pattern. |
| `data.kafka_root` | `/data/kafka` (HEAD) | Same pattern. |

Each sub-tier (`data.postgres`, `data.redis`, `data.kafka`) lights up independently based on its probe.

If `addons.list` shows zero Heroku-owned data-service add-ons, the data tier probes are skipped entirely.

## Tiers and probes — Partner MCP

The Partner MCP's capability picture is different. Each OAuth token is **scoped to one add-on resource**, so probing is per-token.

### Tier: `partner.oauth_basic` (required if any OAuth token configured)

| ID | Path | Token | Notes |
|---|---|---|---|
| `partner.addon_info` | `/addons/${resource_uuid}` | OAuth | Per the Partner docs, this is the canonical "do I have access" probe. |

Lights up: `addon_info`, `addon_attachments_list_by_addon`, `addon_config_get`, `addon_config_update`, `app_info` (for the attached app), `app_collaborators_list`, `app_domains_list`, `log_drain_*` for this resource.

### Tier: `partner.pipelines` (optional, per-partner whitelist)

| ID | Path | Token | Notes |
|---|---|---|---|
| `partner.pipelines_list` | `/pipelines` | OAuth | 403 is normal — most partners aren't whitelisted. |

Lights up: `pipeline_info`, `pipeline_couplings_list`, `pipeline_coupling_info`.

### Tier: `partner.team_members` (optional)

| ID | Path | Token | Notes |
|---|---|---|---|
| `partner.team_members_list` | `/teams/${team_id}/members` | OAuth | Requires knowing the team — derive from `addon_info → app → team`. |

### Tier: `partner.manifest` (gated by manifest credentials, not OAuth)

| ID | Path | Auth | Notes |
|---|---|---|---|
| `partner.installs_list` | `https://addons.heroku.com/api/v3/apps` | Basic (manifest id + api password) | The "all installs of my add-on" endpoint. |

Lights up: `installs_list`, plus the legacy backfill endpoint `vendor_oauth_grant_get` (if Heroku has opened the flag for this partner — surfaced as a tool that returns a structured "feature not enabled" error if it 403s).

### Tier: `partner.webhooks` (always on — no Heroku call required)

The webhook validators don't probe; they're pure-local tools (validate inbound HTTP basic auth, parse a body, etc.). Always exposed.

## Probe execution

1. **Parallel within tiers, serial across base hosts.** All probes against `api.heroku.com` go in one batch; data and addons hosts get their own batches.
2. **Concurrency cap: 5.** Even with 4500/hr rate limit, blasting 20 parallel requests at startup is rude.
3. **Total probe budget: ~15 requests.** Well under any rate limit.
4. **Timeout: 10s per probe.** A hung probe fails open (tier disabled with warning).
5. **Probe-time errors are not fatal except for `account.self`.** A 500 on `enterprise.list` disables the enterprise tier and logs a warning; it does not kill the server.

## Probe result file

Written to `$HEROKU_MCP_HOME/capabilities/<token-fingerprint>.json`:

```json
{
  "schemaVersion": 1,
  "tokenFingerprint": "a7b2c1d3e4f56789",
  "probedAt": "2026-05-22T14:33:01.234Z",
  "ttlSeconds": 3600,
  "tiers": {
    "account": { "available": true, "diagnosticOnly": false },
    "apps":    { "available": true, "probes": { "apps.list": { "status": 200, "rangeRemaining": "..." }}},
    "teams":   { "available": true, "teamCount": 2 },
    "enterprise": { "available": false, "reason": "forbidden", "status": 403 },
    "spaces":  { "available": false, "reason": "forbidden", "status": 403 },
    "addons_consumer": { "available": true },
    "pipelines": { "available": true },
    "data": {
      "postgres": { "available": true },
      "redis":    { "available": false, "reason": "not_found", "status": 404 },
      "kafka":    { "available": false, "reason": "not_found", "status": 404 }
    }
  }
}
```

Field semantics:
- `available: true` means tools in the tier should be advertised.
- `diagnosticOnly: true` (account tier only) suppresses all non-diagnostic tools.
- `reason` is one of `forbidden | not_found | delinquent | suspended | rate_limit | timeout | server_error | network`.

## Refresh

The `refresh_capabilities` tool re-runs the probe matrix, overwrites the cache, and returns the new tier set. Hosts that cache `tools/list` are expected to re-fetch on capability change — MCP supports `notifications/tools/list_changed` and the server emits it after a refresh.

## Test fixtures

For unit tests, `packages/core/test/fixtures/probe-responses/` contains canned responses for every probe result class (200, 401, 402, 403, 404, 429, 500, timeout, network). The prober is tested against the cross-product of (probe, response-class) without touching the network.

Integration tests against a real Heroku account live in `packages/core/test/integration/` and are gated by `HEROKU_MCP_TEST_TOKEN` env var. CI runs them in a manually-triggered workflow only — they cost rate-limit budget and require maintained test accounts.
