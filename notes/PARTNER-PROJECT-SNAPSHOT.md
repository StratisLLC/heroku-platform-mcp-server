# Heroku Partner MCP — Project Snapshot & Standalone Build Plan

**Status:** PARKED. Not on the customer-facing critical path. Build this after the customer Platform MCP reaches 1.0, or hand it to a separate effort. This document is written to be executed COLD — someone who has never seen the rest of the project should be able to build `@heroku-mcp/partner` from this alone, inheriting every pattern the Platform MCP established.

**Last updated:** 2026-05-28. Endpoint inventory verified against devcenter.heroku.com on this date.

---

## 0. What this server is (and the one critical thing to understand first)

The "Heroku Add-on Partner API" is **two different APIs with opposite directions of data flow.** Conflating them is the single most common way to get this wrong. Read this section twice.

### API 1 — Add-on Partner API (INBOUND: Heroku → partner)

Heroku calls the *partner's own service* at the `base_url` registered in the add-on manifest. These are **webhooks the partner receives and implements**, not endpoints anyone calls outward:

- `POST /heroku/resources` — provision (a customer added your add-on)
- `PUT  /heroku/resources/:uuid` — plan change (customer upgraded/downgraded)
- `DELETE /heroku/resources/:uuid` — deprovision (customer removed your add-on)

All three use **HTTP Basic auth**, validated using the `id` and `api:password` from the add-on manifest. The provision request body carries an `oauth_grant.code` (see API 2).

**An MCP cannot "call" these — they are the partner's inbound handlers.** The MCP's role for API 1 is therefore **validation & parsing helpers**: verify the inbound Basic-auth header against manifest credentials, parse/validate provision/planchange/deprovision payloads, extract the grant code, enforce idempotency expectations (same `uuid` → same response; deprovisioned resource → 410). These are local, no-network tools.

### API 2 — Platform API for Partners (OUTBOUND: partner → Heroku)

This is the partner calling *Heroku* back, scoped to a single add-on resource. This is the **real callable API** and the bulk of the MCP's tools.

Flow: provision webhook (API 1) delivers an `oauth_grant.code` → partner exchanges it at `POST https://id.heroku.com/oauth/token` (`grant_type=authorization_code` + `client_secret`) → receives an `access_token` (`HRKU-…`, ~8h TTL) + `refresh_token` (lives for the lifetime of the add-on) → uses the access token as a Bearer token against `api.heroku.com` Platform API endpoints. All responses are **scoped to that one add-on resource** — the add-on only ever sees its own instances and the apps they're attached to.

> **Inherited lesson (do not relearn the hard way):** the customer Platform MCP shipped with token-refresh code written but never wired into the request path, and every hosted user got locked out ~8h after sign-in. For the Partner MCP, **wire refresh in from day one** and add an expired-token-fixture test. Partner access tokens have the same ~8h TTL; the refresh token is long-lived. Proactively refresh when expired or within a 60s buffer; persist Heroku's rotated refresh token every time.

### Why this matters for the MCP's shape

The Partner MCP is therefore **not** a clone of the Platform MCP. It is:
- **~30 callable tools** wrapping the Platform-API-for-Partners (outbound, resource-scoped), most read-only, a few mutating (config update, log drains, add-on actions).
- **~10–16 local helper tools** for the inbound Add-on Partner API webhooks (auth validation, payload parsing, grant extraction) and for the OAuth grant/refresh lifecycle.
- Multi-tenant by **add-on resource**, not by Heroku user. One refresh-token-bearing record per provisioned resource.

---

## 1. Inheritance — what comes from the existing project unchanged

Build `@heroku-mcp/partner` as a new package **in the same monorepo** (`~/Desktop/Github/herokumcp`, pnpm workspaces). It depends on the **published `@heroku-mcp/core`** — NOT a fork, NOT a vendored copy. Core fixes and improvements must propagate to Partner automatically. (Confirmed project decision.)

### From `@heroku-mcp/core` (reuse as-is)

- **`client.ts`** — the Heroku HTTP client (Bearer auth, `Accept: application/vnd.heroku+json; version=3`, error envelope shaping, rate-limit header parsing via `RateLimit-Remaining`). The Partner API IS the Platform API with a resource-scoped token, so this client works directly.
- **`prober.ts` / `probes.ts`** — runtime capability probing. There is no permissions-introspection endpoint; Heroku confirms this for partners too ("A dynamic way to show this is unavailable. Endpoints for which your add-on has insufficient access return an authorization error."). So Partner probes by trying a cheap call per endpoint family and enabling the tier only if it doesn't 403. The base set (add-on resources, attachments, config, app info, collaborators, domains, log drains, pipelines, team members) is available to all add-ons; "And More" (formations, releases, builds) is per-partner-enabled — exactly the kind of thing capability probing exists to discover.
- **`confirm.ts`** — destructive-op confirm pattern (`confirm: string` must match the canonical resource name from a prefetched resource).
- **`dry-run.ts`** — `dry_run: true` on every mutating tool.
- **`crypto.ts`** — envelope encryption (DEK per record, master-key-wrapped). Heroku's own docs MANDATE encrypting `access_token`, `refresh_token`, and `client_secret` at rest. Reuse this directly for the per-resource token store.
- **`audit.ts`** — audit log sink + entry shaping.
- **`errors.ts`, `etag.ts`, `pagination.ts`, `ratelimit.ts`, `redact.ts`, `schema.ts`, `tokens.ts`** — all reused. `tokens.ts` may need a Partner-specific token prefix (see §5).

### From `@heroku-mcp/platform` (reuse as PATTERN, copy + adapt)

Many Platform-API-for-Partners endpoints are the SAME endpoints the Platform MCP already wraps (`GET /apps/{id}`, `GET /apps/{id}/collaborators`, `GET /apps/{id}/domains`, pipeline endpoints, `GET /addons/{id}`, `GET /addons/{id}/config` + `PATCH`, log drains). The Platform MCP's tool implementations for these are a direct template — copy the tool definition, adjust the description to reflect resource-scoping ("only returns instances of YOUR add-on / apps YOUR add-on is attached to"), keep the Zod schema and annotation patterns identical.

**Inherited Zod lesson:** any field a Heroku response MIGHT return as `null` must be `.nullish()`, never `.optional()`. `.optional()` rejects literal `null`. (Cost the Platform project three separate debugging sessions; see its divergences #66.)

### From `@heroku-mcp/http-server` (reuse as PATTERN for the hosted path — §6)

The Partner MCP DOES get an HTTP/OAuth hosted path (confirmed decision), but its multi-tenancy axis differs (per-resource, not per-user). Reuse the structure: Hono app, migration-based Postgres schema, envelope-encrypted token table, middleware, capability-prober-per-session, the `RESPONSE_ALREADY_SENT` fix for SSE responses (Platform divergence #69 — return `RESPONSE_ALREADY_SENT` from `@hono/node-server/utils/response`, never `undefined`, after `transport.handleRequest`).

### Conventions inherited wholesale

- TypeScript strict, ESM, `tsup` builds, `vitest` tests.
- Test helpers: `test/helpers/wiring.ts`, `test/helpers/fake-pool.ts`.
- Constant-time credential comparison (`timingSafeEqualBytes` from core).
- **Divergence discipline:** every deviation from the spec or from Heroku's docs gets a numbered entry in `notes/partner-divergences.md` with Observation + Rule-for-the-future. (Keep Partner divergences in their own file to avoid renumbering churn against the Platform list.)
- Phase tags: `partner-vX.Y.Z`, `partner-http-server-vX.Y.Z`.
- Two test apps / test add-on convention for live integration (you'll need a real registered test add-on in the Add-on Partner Portal — see §8).

---

## 2. Package layout

```
packages/
  core/                     # EXISTING — depend on published @heroku-mcp/core, do not modify for Partner
  partner-mcp/              # NEW — the stdio MCP server
    src/
      index.ts
      index-stdio.ts        # stdio entrypoint (mirrors platform-mcp)
      tokens/
        grant-exchange.ts   # authorization_code grant → access+refresh token
        refresh.ts          # refresh_token → new access token (WIRE IN FROM DAY ONE)
        store.ts            # in-memory/single-resource token holder for stdio mode
      webhook/
        auth.ts             # validate inbound Basic auth vs manifest id/api-password
        parse.ts            # parse provision/planchange/deprovision payloads
      tools/
        resources.ts        # add-on resource reads
        attachments.ts      # add-on attachment reads
        config.ts           # add-on config read + update (mutating)
        appinfo.ts          # app info reads
        collaborators.ts    # app collaborator reads
        domains.ts          # app domain reads
        logdrains.ts        # log drain read + create/update/delete (mutating)
        pipelines.ts        # pipeline reads
        teammembers.ts      # team member reads
        actions.ts          # add-on action endpoints (async provision/deprovision completion) (mutating)
        dynos.ts            # dyno stop (async deprovision) (mutating) — per-partner-enabled
        webhook-helpers.ts  # local validation/parse tools (no network)
        diagnostics.ts      # whoami-equivalent (resource self), rate-limit status, schema info, audit tail
      mcp/setup.ts          # tool registration, capability gating
  partner-http-server/      # NEW — hosted multi-tenant-by-resource path (§6)
  admin-cli/                # EXISTING pattern — may extend or mirror for partner ops
```

---

## 3. The callable tool inventory (Platform API for Partners — OUTBOUND)

All endpoints below are **resource-scoped**: authenticated with a per-add-on-resource access token; responses only include that add-on's own instances and the apps it's attached to. Verified list as of 2026-05-28. Base path `https://api.heroku.com`, `Accept: application/vnd.heroku+json; version=3`.

### Tier: Add-on Resources (read-only)
| Tool | Method/Path | Notes |
|---|---|---|
| `partner_addon_info` | `GET /addons/{id_or_name}` | Primary app in `app` object. |
| `partner_addons_list` | `GET /addons` | All instances of THIS add-on service. |
| `partner_addons_by_user` | `GET /users/{email_or_id_or_self}/addons` | |
| `partner_addons_by_app` | `GET /apps/{app_id_or_name}/addons` | |

### Tier: Add-on Attachments (read-only)
| Tool | Method/Path |
|---|---|
| `partner_attachments_by_addon` | `GET /addons/{id_or_name}/addon-attachments` |
| `partner_attachments_by_app` | `GET /apps/{app_id_or_name}/addon-attachments` |
| `partner_attachment_info_by_app` | `GET /apps/{app_id_or_name}/addon-attachments/{id_or_name}` |

### Tier: Add-on Configuration (read + WRITE)
| Tool | Method/Path | Mutating |
|---|---|---|
| `partner_addon_config_get` | `GET /addons/{id_or_name}/config` | no |
| `partner_addon_config_update` | `PATCH /addons/{id_or_name}/config` | **yes** — confirm + dry_run. Body `{config:[{name,value}]}`. This is how the add-on writes the resource URL / connection vars back to the customer app. |

### Tier: App Info (read-only)
| Tool | Method/Path |
|---|---|
| `partner_app_info` | `GET /apps/{app_id_or_name}` |
| `partner_apps_list` | `GET /apps` | (As of Sep 2022, the addons.heroku.com API V3 `/apps` endpoint lists all apps where the add-on is installed. Mirror the Platform MCP's `apps_list` / consider a `partner_apps_list_all` only if a union across attachments is meaningful — usually not, since scoping already limits it.) |
| `partner_apps_by_user` | `GET /users/{email_or_id_or_self}/apps` |
| `partner_apps_filter` | `POST /filters/apps` | Body carries app id list. |

### Tier: App Collaborators (read-only)
| Tool | Method/Path |
|---|---|
| `partner_collaborators_list` | `GET /apps/{app_id_or_name}/collaborators` |

### Tier: Domains (read-only)
| Tool | Method/Path |
|---|---|
| `partner_domains_list` | `GET /apps/{app_id_or_name}/domains` |

### Tier: Log Drains (read + WRITE)  — NOT available on Fir-generation apps
| Tool | Method/Path | Mutating |
|---|---|---|
| `partner_logdrains_by_addon` | `GET /addons/{id_or_name}/log-drains` | no |
| `partner_logdrain_update` | `PUT /addons/{id_or_name}/log-drains/{id_or_url_or_token}` | **yes** |
| `partner_logdrain_create` | `POST /apps/{app_id_or_name}/log-drains` | **yes** |
| `partner_logdrain_delete` | `DELETE /apps/{app_id_or_name}/log-drains/{id_or_url_or_token}` | **yes** — confirm + dry_run |

### Tier: Pipelines (read-only)
| Tool | Method/Path |
|---|---|
| `partner_pipeline_info` | `GET /pipelines/{id_or_name}` |
| `partner_pipelines_list` | `GET /pipelines` |
| `partner_pipeline_couplings_by_pipeline` | `GET /pipelines/{id}/pipeline-couplings` |
| `partner_pipeline_couplings_list` | `GET /pipeline-couplings` |
| `partner_pipeline_coupling_info` | `GET /pipeline-couplings/{id}` |
| `partner_pipeline_couplings_by_app` | `GET /apps/{app_id_or_name}/pipeline-couplings` |

### Tier: Team Members (read-only)
| Tool | Method/Path |
|---|---|
| `partner_team_members_list` | `GET /teams/{team_name_or_id}/members` |

### Tier: "And More" (per-partner-enabled — gate behind capability probe)
These are NOT granted by default; Heroku enables them per-partner on request. The capability prober will discover them (403 if not enabled). Wrap them but expect them dark for most add-ons:
| Tool | Method/Path |
|---|---|
| `partner_formations_list` | `GET /apps/{app}/formation` |
| `partner_releases_list` | `GET /apps/{app}/releases` |
| `partner_builds_list` | `GET /apps/{app}/builds` |

### Tier: Add-on Actions (async lifecycle completion — WRITE)
Used to complete asynchronous provisioning/deprovisioning. The partner tells Heroku "provisioning succeeded/failed" or "deprovisioning is done." Exact paths come from the async-provisioning and async-deprovisioning articles (the "Add-on Action" provision/deprovision endpoints). These are mutating and important:
| Tool | Purpose | Mutating |
|---|---|---|
| `partner_action_provision_complete` | Signal async provision success | **yes** |
| `partner_action_provision_fail` | Signal async provision failure (resource removed, customer not charged) | **yes** |
| `partner_action_deprovision_complete` | Signal async deprovision done (within 12h window, else auto-completed) | **yes** |
| `partner_dyno_stop` | Stop a partner-controlled one-off dyno during async deprovision | **yes** — per-partner-enabled |

> When building: fetch the exact Add-on Action endpoint shapes from `getting-started-with-asynchronous-provisioning` and `asynchronous-deprovisioning-of-addons` at build time — they were not fully enumerated in the snapshot source and may have changed. There is also a "log input URL" associated with the add-on resource for writing log messages during async deprovision; wrap as `partner_resource_log_write` if the use case is in scope.

### Tier: SSO (read/local)
The add-on manifest defines an SSO salt + SSO URL. Single sign-on between the Heroku admin panel and the partner's admin panel uses a shared secret. Wrap SSO token **validation** as a local helper (`partner_sso_validate`) — verify the SSO payload/timestamp/token the same way the inbound webhook auth is validated. (This is partner-receives-request, like API 1.)

---

## 4. The local helper tool inventory (Add-on Partner API — INBOUND + OAuth lifecycle)

These do **no outbound Heroku calls** (except the token endpoints, which hit `id.heroku.com`). They help the partner correctly handle what Heroku sends them.

| Tool | Purpose | Network |
|---|---|---|
| `partner_webhook_validate_auth` | Given an inbound request's Authorization header + the manifest `id`/`api:password`, constant-time-verify it. | none |
| `partner_webhook_parse_provision` | Parse `POST /heroku/resources` body → `{uuid, plan, region, options, oauth_grant{code,type,expires_at}, callback_url, log_input_url, ...}`. Validate required fields. Surface the grant code. | none |
| `partner_webhook_parse_planchange` | Parse `PUT /heroku/resources/:uuid` body → `{uuid, plan, ...}`. Flag same-plan no-op (best practice: idempotent 200). | none |
| `partner_webhook_parse_deprovision` | Parse `DELETE /heroku/resources/:uuid` (no body; uuid from URL). | none |
| `partner_grant_exchange` | Exchange `oauth_grant.code` → access+refresh token. `POST https://id.heroku.com/oauth/token` `grant_type=authorization_code&code=…&client_secret=…`. 5-min code TTL. Store encrypted. | id.heroku.com |
| `partner_token_refresh` | `grant_type=refresh_token&refresh_token=…&client_secret=…`. Returns new access token (+ rotated refresh). WIRE INTO REQUEST PATH, don't just expose. | id.heroku.com |
| `partner_grant_backfill` | For pre-Platform-API installs: `GET https://<user>:<pass>@api.heroku.com/vendor/resources/:resource_uuid/oauth-grant` (App Info API; blocked by default, per-partner unlocked). Returns an oauth_grant to exchange. | api.heroku.com |
| `partner_sso_validate` | Validate inbound SSO token against manifest SSO salt. | none |

Plus diagnostics mirroring the Platform MCP's no-probe baseline: `partner_whoami` (resource self-introspection — `GET /addons/{self_uuid}`), `partner_rate_limit_status`, `partner_schema_info`, `partner_audit_tail`, `partner_refresh_capabilities`.

---

## 5. Token & credential model

- **OAuth client secret** (one per add-on, from the Add-on Partner Portal "OAuth Credentials" page) — authenticates grant-exchange and refresh calls. Encrypt at rest (envelope crypto from core). NEVER used to authenticate normal Platform API requests — only token mint/refresh.
- **Per-resource access token** (`HRKU-…`, ~8h TTL) + **refresh token** (lifetime of the add-on). One pair per provisioned resource. Encrypted at rest.
- **Manifest Basic-auth credentials** (`id`, `api:password`) — validate INBOUND webhook calls. Store as config, not per-resource.
- **MCP connection credential**: reuse the `hmcp_`-style prefix pattern but distinct — suggest `hmcpp_` (p for partner) so partner connection tokens are distinguishable in logs from platform `hmcp_` tokens. Refresh-token prefix for the OAuth provider layer: `hmcpprt_`.

**Credential rotation:** Heroku's "Reset" on the OAuth Credentials page immediately invalidates ALL access tokens; they must be refreshed with the new client secret. The hosted path must handle a global client-secret change gracefully (config reload + re-refresh on next use). Note this as a divergence/risk.

---

## 6. Hosted HTTP/OAuth path (confirmed in scope)

Mirror `@heroku-mcp/http-server` structurally, but the tenancy axis is **per-add-on-resource**, not per-Heroku-user:

- Postgres schema (migration 0001): `partner_resources` (uuid PK, encrypted_access_token, encrypted_refresh_token, encrypted_dek, expires_at, refreshed_at, plan, region, primary_app_id, created_at), `partner_config` (the add-on's own manifest creds + OAuth client secret, encrypted), `connection_tokens` (the `hmcpp_` MCP credentials), `audit_log`. If exposing an OAuth 2.1 provider for client connection (so an MCP client like Claude Desktop can connect), add the migration-0002 OAuth provider tables exactly as the Platform http-server did (oauth_clients, oauth_authorizations, oauth_tokens) — same DCR/authorize/token/revoke + `.well-known` endpoints, same `RESPONSE_ALREADY_SENT` SSE fix.
- **Key difference:** there is no "Heroku sign-in" detour for the end user. The partner operator configures the add-on's OAuth client secret + manifest creds once. A connecting MCP client selects/has-scoped a particular add-on resource. How a client picks WHICH resource to operate on is the main design question to resolve at build time — likely a required `resource_uuid` argument on every tool, or a connection bound to one resource. **Decide this before building the hosted path.**
- The capability prober runs per resource-token (probe `GET /addons/{uuid}` as the `account.self` equivalent).
- Wire token refresh into `resolveResourceAccessToken` from day one (the Platform lesson).

---

## 7. Build phases (standalone)

- **P-0 — scaffold.** New `partner-mcp` package, depend on published `@heroku-mcp/core`, tsup/vitest/eslint wired, stdio entrypoint that registers only diagnostics + webhook-helper (no-network) tools. Tag `partner-v0.1.0`. Proves the core dependency resolves and the harness works.
- **P-1 — OAuth lifecycle.** `grant-exchange`, `refresh` (wired, not just exposed), encrypted token store, `grant_backfill`. Live test against a real test add-on's provision webhook. Tag `partner-v0.2.0`.
- **P-2 — read tools.** All read-only tiers (resources, attachments, config-get, app info, collaborators, domains, log-drains-list, pipelines, team members) + capability probing. Tag `partner-v0.3.0`.
- **P-3 — write tools.** config update, log drain create/update/delete, add-on actions (async provision/deprovision completion), dyno stop. confirm + dry_run on all. Tag `partner-v0.4.0`.
- **P-4 — webhook validators.** Inbound Basic-auth validation, provision/planchange/deprovision parsers, SSO validation. (Mostly local; high test value.) Tag `partner-v0.5.0`.
- **P-5 — hosted HTTP/OAuth path** (§6). Tag `partner-http-server-v0.1.0`.
- **P-6 — deploy repo** `herokumcp-partner-deploy` (Heroku Button), mirroring the Platform deploy repo. 
- **P-7 — hardening + 1.0.**

---

## 8. Prerequisites to actually build this

1. **A registered test add-on** in the Add-on Partner Portal (`addons.heroku.com/provider`) with: a manifest (base_url, sso salt, api password, regions), v3 Provisioning API selected, and the Platform-API-for-Partners flag enabled (default for new add-ons; legacy add-ons need a support ticket). Get the OAuth client secret from the OAuth Credentials page.
2. A way to receive provision webhooks during testing (the add-on's base_url must be reachable — ngrok or a deployed test endpoint, same tunneling story as the Platform hosted path).
3. The reference implementation `github.com/heroku/sudo-sandwich` — read it before P-1; it's the canonical example of the provision→grant→exchange→config-set flow.
4. Confirm exact Add-on Action endpoint shapes from the async provisioning/deprovisioning articles at build time (snapshot did not fully enumerate them).

---

## 9. Open design questions to resolve before building (don't guess)

1. **Hosted resource selection (§6):** how does a connected MCP client indicate which add-on resource to act on? Required per-tool `resource_uuid` arg, vs connection-bound-to-resource. Affects every tool signature.
2. **`partner_apps_list_all` analog:** probably unnecessary since resource-scoping already limits the set, unlike the customer Platform case (where 74-vs-558 drove the meta-tool). Confirm before adding.
3. **Async action endpoint exact contracts** — fetch fresh.
4. **Fir-generation guards:** log drains are unavailable on Fir apps; the add-on can't access Fir app logs. Tools should detect and return a clear "not supported on Fir" error rather than a raw Heroku error.
5. **Idempotency surfacing:** provision is retried up to 24h; deprovisioned resource must return 410. The webhook-parse helpers should make this easy for the partner to honor.

---

## 10. Reference links (verified 2026-05-28)

- Platform API for Partners (the outbound endpoint list): devcenter.heroku.com/articles/platform-api-for-partners
- Add-on Partner API Reference (inbound webhooks): devcenter.heroku.com/articles/add-on-partner-api-reference
- Add-on Manifest: devcenter.heroku.com/articles/add-on-manifest
- Building an Add-on (provision/deprovision/planchange shapes): devcenter.heroku.com/articles/building-an-add-on
- Async provisioning: devcenter.heroku.com/articles/getting-started-with-asynchronous-provisioning
- Async deprovisioning: devcenter.heroku.com/articles/asynchronous-deprovisioning-of-addons
- Add-on webhooks: devcenter.heroku.com/articles/addon-webhooks
- Reference impl: github.com/heroku/sudo-sandwich
- Platform API reference (all endpoint schemas the scoped token reuses): devcenter.heroku.com/articles/platform-api-reference

---

## 11. The one-paragraph version (for whoever picks this up)

Build `@heroku-mcp/partner` in the existing monorepo, depending on published `@heroku-mcp/core`. It wraps the **Platform API for Partners** (outbound, resource-scoped Heroku calls — ~30 tools, mostly reads plus config-update / log-drains / async add-on-actions) and provides **local helpers** for the **Add-on Partner API** (inbound webhooks Heroku sends the partner — auth validation + payload parsing) and the **OAuth grant/refresh lifecycle** (exchange the provision-time grant code at id.heroku.com, refresh the ~8h token using the long-lived refresh token — WIRE REFRESH IN FROM DAY ONE). Reuse the confirm/dry_run safety model, capability probing, envelope encryption, audit log, and (for the hosted path) the HTTP/OAuth-provider structure with the `RESPONSE_ALREADY_SENT` SSE fix — all proven in the customer Platform MCP. Tenancy is per-add-on-resource, not per-user. Get a test add-on registered in the Partner Portal first.
