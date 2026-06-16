# Heroku MCP — Architecture

> Canonical design document. Read this first. Other documents (`CAPABILITY_PROBES.md`, `TOOLS.md`, `HANDOFF.md`) elaborate specific subsystems and assume the model defined here.

## 1. Goals

- Expose the Heroku **Platform API** and the **Platform API for Partners** as Model Context Protocol (MCP) servers, so MCP-aware hosts (Claude Desktop, Claude Code, etc.) can drive Heroku.
- Ship **two** servers — `heroku-platform-mcp` (Customer) and `heroku-partner-mcp` (Partner) — backed by a **shared core**.
- The set of tools a host sees must reflect what the caller's credentials can actually do. Endpoints the caller cannot reach must not appear as tools.
- Be safe by default: destructive operations require explicit confirmation; secrets never appear in logs or tool responses unless deliberately requested.
- Be operable by humans: clear error mapping, rate-limit awareness, paginated responses, audit trail.

## 2. Non-goals (v1)

- Implementing Heroku's CLI behavior in full. We expose APIs, not workflow sugar (`heroku run`, `heroku ps:exec`, `git push heroku`).
- Building a long-running Partner *service* (i.e. the HTTP endpoints Heroku calls into when provisioning). The Partner MCP exposes the *partner-to-Heroku* direction as tools, and provides **validators and scaffolding** for the inbound direction — but does not host webhooks itself.
- Multi-tenant deployment. Both MCPs are designed to run as `stdio` servers per user.
- A web UI. Configuration is via CLI args, env vars, and a config file.

## 3. The two MCPs

### 3.1 `heroku-platform-mcp` — Customer-facing

**Audience:** Heroku developers, team admins, enterprise admins, ops engineers.

**Credentials:** A personal API token (`Authorization: Bearer <token>`). Obtained via `heroku authorizations:create` or the Account → Settings → API Key page.

**Surface:** Effectively the entire Platform API at `api.heroku.com`, plus the data-store APIs at `api.data.heroku.com` (Heroku Postgres, Key-Value Store, Apache Kafka). The actual exposed tool set is determined at runtime by capability probing — see §5.

**Token type one only.** No OAuth flow, no refresh tokens. If the token is invalid the server refuses to start with a clear message.

### 3.2 `heroku-partner-mcp` — Add-on Partner-facing

**Audience:** Engineers building or operating a Heroku add-on.

**Credentials, either or both:**
1. **OAuth credentials** — an OAuth `client_secret` from the Add-on Partner Portal plus zero or more per-resource `(access_token, refresh_token)` pairs. Each token pair is scoped to a single provisioned add-on resource. This is the canonical credential per the Platform API for Partners docs.
2. **Manifest credentials** — the add-on manifest `id` and `api:password` used as HTTP Basic auth. Required for: validating inbound provision/plan-change/deprovision/SSO requests from Heroku, listing all installs of the add-on via `addons.heroku.com/api-docs`, and using the legacy `/vendor/resources/:uuid/oauth-grant` backfill endpoint.

**Surface:**
- The Partner subset of the Platform API (~20 endpoints, see `TOOLS.md`).
- The OAuth grant/refresh lifecycle.
- Inbound webhook validators and manifest tooling.

**Tool gating:** tools that need OAuth tokens are hidden if no OAuth credentials are configured; tools that need manifest auth are hidden if the manifest credentials are missing.

## 4. Repository layout

Monorepo, pnpm workspaces, TypeScript.

```
heroku-mcp/
├── package.json                    # workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .changeset/                     # release management
├── .github/workflows/              # CI: lint, typecheck, test, build
├── LICENSE                         # Apache-2.0
├── TRADEMARKS.md
├── README.md
├── ARCHITECTURE.md                 # this file
├── CAPABILITY_PROBES.md
├── TOOLS.md
├── HANDOFF.md
├── packages/
│   ├── core/                       # @heroku-mcp/core — shared library
│   │   ├── src/
│   │   │   ├── client.ts           # HTTP client (fetch wrapper)
│   │   │   ├── schema.ts           # /schema fetch + parse + cache
│   │   │   ├── prober.ts           # capability probing
│   │   │   ├── tokens.ts           # token storage (keychain + file fallback)
│   │   │   ├── ratelimit.ts        # RateLimit-Remaining tracker
│   │   │   ├── etag.ts             # ETag/If-None-Match cache
│   │   │   ├── pagination.ts       # Content-Range/Next-Range helpers
│   │   │   ├── errors.ts           # Heroku error → typed errors
│   │   │   ├── audit.ts            # JSONL audit log
│   │   │   ├── redact.ts           # secret redaction
│   │   │   └── index.ts
│   │   ├── test/
│   │   └── package.json
│   ├── platform-mcp/               # @heroku-mcp/platform — Customer server
│   │   ├── src/
│   │   │   ├── server.ts           # MCP server bootstrap
│   │   │   ├── tools/              # one file per capability tier
│   │   │   │   ├── account.ts
│   │   │   │   ├── apps.ts
│   │   │   │   ├── teams.ts
│   │   │   │   ├── enterprise.ts
│   │   │   │   ├── spaces.ts
│   │   │   │   ├── addons.ts
│   │   │   │   └── data.ts         # postgres/redis/kafka
│   │   │   └── index.ts            # CLI entry: `heroku-platform-mcp`
│   │   └── package.json
│   └── partner-mcp/                # @heroku-mcp/partner — Partner server
│       ├── src/
│       │   ├── server.ts
│       │   ├── oauth.ts            # grant exchange, refresh, backfill
│       │   ├── tools/
│       │   │   ├── lifecycle.ts    # mark_provisioned, mark_deprovisioned
│       │   │   ├── platform.ts     # Partner subset of Platform API
│       │   │   ├── webhooks.ts     # inbound validators
│       │   │   └── manifest.ts
│       │   └── index.ts            # CLI entry: `heroku-partner-mcp`
│       └── package.json
└── examples/                       # example configs, smoke-test scripts
```

**Toolchain:**
- Node ≥ 20 (uses native `fetch`, `node:test` available if preferred over vitest).
- TypeScript 5.x in strict mode.
- pnpm 9.x for workspaces.
- Test runner: vitest (fast, ESM-native, good fixture support).
- Lint: eslint + @typescript-eslint, prettier for formatting.
- Build: `tsup` per package (ESM output, source maps, types).
- Release: changesets (independent versioning, lets `core` evolve without forcing major bumps on the servers).
- CI: GitHub Actions — typecheck, lint, test on Node 20 + 22, publish on tag.

## 5. Capability discovery

> Heroku exposes no permissions-introspection endpoint. The Partner docs state this explicitly. We probe.

### 5.1 Schema fetch

On startup the core calls `GET https://api.heroku.com/schema` with `Accept: application/vnd.heroku+json; version=3`. The response is a JSON Schema describing every resource, every endpoint, every parameter. Cached on disk for 24h keyed by ETag (the response carries one). Drives request validation and type generation.

A `--regenerate-types` script in `packages/core` fetches the schema and emits TS types to `packages/core/src/generated/`. These get committed so consumers don't need network at build time. CI runs the regeneration weekly and opens a PR if anything changed.

### 5.2 Probe phase

After schema load, the prober issues a curated set of cheap GET requests (see `CAPABILITY_PROBES.md` for the full matrix). Each probe maps to a *capability tier*. Result classification:

| Response | Meaning | Action |
|---|---|---|
| 200 / 206 | caller can read this family | enable the tier's tools |
| 401 unauthorized | token invalid | abort startup, exit 1 with clear message |
| 402 delinquent | account behind on payment | enable diagnostic tools only; hide writes |
| 403 forbidden | caller has no access to this family | hide the tier |
| 403 suspended | account or app suspended | enable diagnostic tools only; hide writes |
| 404 not_found | family accessible, no instances yet | enable tier; tools report "no resources" |
| 429 rate_limit | hit rate limit during probe | retry once with backoff; if still 429, fail open (enable tier, surface limit warnings) |

### 5.3 Probe cache

Probe results are cached at `$HEROKU_MCP_HOME/capabilities/<token-fingerprint>.json` with default TTL 1h. `token-fingerprint` is the first 16 chars of SHA-256 of the token; the token itself is never written to the cache file.

A `refresh_capabilities` tool is always exposed (even before any tier lights up) so the caller can re-probe after a role change without restarting the server.

### 5.4 Advertising tools

The MCP `tools/list` response is built dynamically from the cached capability set. Hosts therefore see only tools that will actually work. This is the right idiom — hosts should not have to handle "tool exists but always 403s."

## 6. Token storage

Per the decision in planning:

**Primary:** OS keychain via [`@napi-rs/keyring`](https://github.com/napi-rs/keyring) (chosen over the archived `keytar` during Phase 0; provides the same Entry-based API with maintained prebuilds for every supported platform). Service name: `heroku-mcp`. Account names: `platform:<fingerprint>` or `partner:<client_id>:<resource_uuid>`. Because the keychain has no enumeration API, the store maintains a small plaintext index file listing known account names — non-secret derivations of fingerprints/client ids — alongside the keychain itself.

**Fallback:** AES-256-GCM encrypted file at `$HEROKU_MCP_HOME/tokens.enc`. Encryption key derived from a passphrase supplied via `HEROKU_MCP_PASSPHRASE` env var (PBKDF2, 600k iterations, per-file salt). If neither keychain nor passphrase is available, the server refuses to persist tokens and instead accepts them only via env vars or `--token` flag, with a warning printed.

**Never:** plaintext disk, logs, MCP responses, error messages.

The `core/src/tokens.ts` module exposes:
```ts
interface TokenStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}
```
with a factory `createTokenStore(opts)` that tries keychain first, falls back to file, then to ephemeral in-memory with a warning.

## 7. Request lifecycle

Every outbound request to Heroku goes through `core/src/client.ts`:

1. **Build headers:** `Authorization: Bearer <token>`, `Accept: application/vnd.heroku+json; version=3`, `User-Agent: heroku-mcp/<version> (<server-name>)`, plus per-call extras.
2. **ETag lookup:** if a cached ETag exists for this URL+method, set `If-None-Match`.
3. **Issue with timeout:** 30s default, configurable per tool.
4. **Rate-limit accounting:** read `RateLimit-Remaining`; if <100, switch the client to a serial queue; if 0, return a typed `RateLimitError` with the reset hint rather than blasting retries.
5. **ETag store:** on 200, store `(url, method, etag, body, expires)`. On 304, return cached body.
6. **Error mapping:** 4xx/5xx are parsed into `HerokuApiError` with `{ status, id, message, url, requestId }`. The Heroku `Request-Id` header is preserved for support tickets.
7. **Audit log:** for mutating methods (POST/PATCH/PUT/DELETE), append a JSONL line to `$HEROKU_MCP_HOME/audit-<YYYY-MM-DD>.log` containing `{timestamp, tool, method, url, target, tokenFingerprint, status, requestId, durationMs}`. Bodies are never logged.

Retries: only on `429` and `503`, exponential backoff (250ms, 500ms, 1s, 2s, 4s), max 5 attempts. `POST` is retried only when the response includes `Retry-After`; PATCH/DELETE/PUT are retried only if the call is idempotent in Heroku's sense (most are — Heroku follows at-least-once delivery on the Partner side and most Platform writes are idempotent by ID).

## 8. Tool conventions

Every tool follows these rules:

### 8.1 Naming

- `<resource>_<action>` snake_case. Examples: `apps_list`, `apps_info`, `apps_create`, `apps_delete`, `config_vars_get`, `formation_scale`.
- Cross-resource actions name both: `team_app_collaborators_list`.
- Diagnostic/meta tools start with an underscore-free prefix: `refresh_capabilities`, `rate_limit_status`, `whoami`.

### 8.2 Parameters

- JSON Schema validated. Required vs optional explicit.
- IDs accept either UUID or human name where Heroku does, but the tool description says "prefer UUID."
- Pagination: `page_size` (default 200, max 1000), `cursor` (opaque, derived from `Next-Range`).
- Every mutating tool accepts `dry_run: boolean` — when true, the tool validates, builds the request, and returns the would-be HTTP request as structured output without executing.

### 8.3 Destructive operations

Tools that delete, scale to zero, transfer ownership, rotate credentials, or remove collaborators require `confirm: string`. The confirm value must equal the human-readable name of the target (app name, team name, etc.). Mismatched confirms return a typed `ConfirmationMismatchError` without making the API call. Tools that are destructive are listed in `TOOLS.md` with a `⚠` marker.

### 8.4 OTP/password-gated operations

Some Heroku endpoints (`DELETE /account`, certain enterprise ops) require an `HTTP_HEROKU_PASSWORD` header. These tools are **hidden by default**. Pass `--allow-account-deletion` at server startup to expose them. Even when exposed, they require `confirm` matching the email.

### 8.5 Responses

Tools return Heroku's JSON body unchanged on success, with one wrapping layer:
```ts
{
  ok: true,
  data: <heroku response>,
  meta: {
    requestId: string,
    rateLimitRemaining: number,
    pagination?: { hasMore: boolean, cursor?: string },
    cached?: boolean   // true if served from ETag cache
  }
}
```
On failure:
```ts
{
  ok: false,
  error: {
    kind: 'auth' | 'forbidden' | 'not_found' | 'rate_limit' | 'delinquent' | 'invalid_params' | 'conflict' | 'server' | 'network' | 'confirmation',
    status?: number,
    herokuId?: string,    // e.g. "rate_limit"
    message: string,
    requestId?: string,
    docUrl?: string
  }
}
```

## 9. Secret redaction

`core/src/redact.ts` exports `redact(value, opts)` which walks any JSON value and replaces:
- keys named `password`, `token`, `secret`, `client_secret`, `access_token`, `refresh_token`, `api_key`, `Authorization` (case-insensitive)
- values matching `HRKU-[a-f0-9-]+`
- values matching the bearer token regex
- the `config_vars` map values (keys are kept)

with `"[REDACTED]"`. This is applied to: all log output, all error messages bubbled to tool responses, the audit log payload. It is **not** applied to legitimate tool responses where the caller has explicitly requested the value (e.g. `config_vars_get` — the whole point of the tool is to return values; redaction would defeat it).

## 10. Audit log

JSONL at `$HEROKU_MCP_HOME/audit-<YYYY-MM-DD>.log`. One line per mutating call. Rotated daily, retained 30 days by default (configurable). Format:

```json
{"ts":"2026-05-22T14:33:01.234Z","server":"platform","tool":"apps_delete","method":"DELETE","url":"https://api.heroku.com/apps/example","target":"example","tokenFp":"a7b2c1d3e4f5...","status":200,"requestId":"abc123","durationMs":412}
```

A `audit_tail` tool exposes the last N entries for the current day to the host (helps the model self-narrate "I deleted X at HH:MM" without re-running calls).

## 11. Security posture

- **No outbound traffic** except to `api.heroku.com`, `id.heroku.com`, `addons.heroku.com`, and `api.data.heroku.com`. Hard-coded allowlist in the client.
- **No user data leaves the host.** Tokens and capability cache stay local. The audit log stays local.
- **TLS verification on.** No `NODE_TLS_REJECT_UNAUTHORIZED=0`. Certificate pinning is overkill; default Node TLS is sufficient.
- **Dependency hygiene.** `pnpm audit` in CI, dependabot, no postinstall scripts allowed in production deps.
- **Token lifetime:** Partner access tokens auto-refresh via the refresh token when a 401 is observed. Single-flight refresh per `(client_secret, refresh_token)` to avoid stampedes.
- **Compliance framing.** The MCP processes Heroku-side data on behalf of the user. It is not a data processor in its own right. Customers requiring SOC 2 / HIPAA workflows should use the same precautions they already use for the Heroku CLI; nothing about the MCP weakens Heroku's compliance posture (per heroku.com/policy/security and the security-and-compliance-resources article).

## 12. Error handling philosophy

- Surface Heroku's error verbatim in the `message`. Don't paraphrase. The `herokuId` field lets hosts react programmatically.
- Map to a small typed `kind` enum the host can switch on.
- For `delinquent` and `suspended`, the message should include the dashboard URL since those are not API-fixable.
- For `rate_limit`, include the reset hint computed from `RateLimit-Remaining` trajectory.
- For `invalid_params`, echo back the field names Heroku flagged. This is essential for models that build requests by trial.

## 13. Logging

Three sinks:
1. **stderr (always):** structured JSON, one event per line, MCP transport-safe. Level controlled by `HEROKU_MCP_LOG_LEVEL` (`debug|info|warn|error`).
2. **Audit log (always for mutations):** see §10.
3. **Optional file log:** `HEROKU_MCP_LOG_FILE=path` enables a mirror of stderr to a file.

All logging passes through `redact()`. No request bodies, no response bodies, no headers other than `Request-Id` and `RateLimit-Remaining`.

## 14. Configuration resolution order

For any setting, resolution is:
1. CLI flag
2. Environment variable (`HEROKU_MCP_*`)
3. Config file at `$HEROKU_MCP_HOME/config.json`
4. Default

`HEROKU_MCP_HOME` defaults to `$XDG_CONFIG_HOME/heroku-mcp` on Linux, `~/Library/Application Support/heroku-mcp` on macOS, `%APPDATA%\heroku-mcp` on Windows.

## 15. Phased delivery

| Phase | Scope | Acceptance |
|---|---|---|
| **0 — Core** | `packages/core` complete: client, schema, prober, tokens, ratelimit, etag, errors, audit, redact. | Unit tests pass; `core` builds; smoke test against real token succeeds for `GET /account`. |
| **1 — Platform v0.1** | Account + Apps tiers, read-only. Capability probing live. | `tools/list` reflects probe results; reads against a real account work end-to-end. |
| **2 — Platform v0.2** | Writes for Apps/Config/Formation/Releases with confirm guards; Teams tier added. | Destructive ops require confirm; `dry_run` works; teams tools light up only when probe sees a team. |
| **3 — Platform v0.3** | Enterprise, Spaces, Add-ons (consumer side), Pipelines, Review Apps. | Same probe-gated pattern; full TOOLS.md tier coverage. |
| **4 — Partner v0.1** | OAuth lifecycle (grant exchange, refresh, backfill) + Partner subset of Platform API. | Round-trip against a sandbox add-on works; tokens persisted encrypted. |
| **5 — Partner v0.2** | Webhook validators + manifest tooling. | Given a captured raw Heroku request, the validator returns parsed payload + verdict. |
| **6 — Data APIs** | `api.data.heroku.com` integration: Postgres, Key-Value Store, Kafka. | Tools gated by add-on type; treat 404 gracefully. |
| **7 — Hardening** | Audit-trail tooling, docs, examples, release automation. | First `1.0.0` tag; published to npm. |

Each phase ends with a changeset and a tagged release (`0.X.0`). `1.0.0` is cut after Phase 7.

## 16. Open questions for future phases

These do not block v1 but should be revisited:

- **OAuth user flow.** Should `heroku-platform-mcp` ever support OAuth on behalf of a human user (not just static API tokens)? Today, no — API tokens are the right primitive. Worth re-examining if Heroku ships a device-code flow.
- **Streaming logs.** `POST /apps/{id}/log-sessions` returns a URL to a streamable log. MCP doesn't have a great streaming-tool idiom yet. v1 returns the URL and lets the host stream it; revisit when MCP streaming matures.
- **Heroku Inference / AI APIs.** Out of scope for v1. Likely a third MCP (`heroku-inference-mcp`) when stable.
- **Webhook *receiver* mode.** A long-running mode where the Partner MCP hosts the inbound Heroku endpoints. Significant scope; punt to a separate project.
