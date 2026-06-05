# Phase 6 Part A — Corrections Handoff

**Status of Phase 6 Part A:** code shipped, postgres-v0.1.0 tagged, 797 unit tests passing — but **live integration test failed** because the implementation was based on assumed API behavior, not the actual Heroku Data API. This handoff documents the corrections needed to make Phase 6 Part A actually work against a real Heroku Postgres database.

The previous handoff explicitly warned: *"Response shapes are assumptions. I have no live token; backup/follower/credential/query-stats payload shapes (and the exact pg_backups_url action path, query-stats vs query_insights, schedule path) follow the handoff/CLI conventions and pass through verbatim where possible."* Live integration revealed those assumptions were wrong in important ways. This document fixes them.

---

## Ground truth source: the Heroku CLI

The Heroku CLI source code at `github.com/heroku/cli` is the canonical reference for what URLs to call, what auth scheme to use, and what response shapes to expect. All corrections below cite specific CLI source files.

Note: the Heroku CLI is split across two repos in different eras. Older path was `packages/cli/src/commands/pg/...` (e.g. `v10.15.0`). Current is `src/commands/pg/...` (e.g. `v11.4.0`). Both branches use identical API endpoints; cite either.

---

## The biggest finding: TWO API namespaces, TWO auth schemes

The Heroku Data API at `api.data.heroku.com` (which the CLI calls `utils.pg.host()`) exposes **two completely different path prefixes on the same hostname**:

### Namespace A: `/client/v11/*` (Bearer auth)

Used for:
- Database info, links, transfers (backups), transfer-schedules
- Connection reset, metrics

Auth: same as Platform API — `Authorization: Bearer <token>`, `Accept: application/vnd.heroku+json; version=3`.

### Namespace B: `/postgres/v0/*` (Basic auth)

Used for:
- Credentials (list, get, create, destroy, rotate, repair-default)
- Database settings/config
- Connection pooling

Auth: HTTP **Basic** auth where username is empty and password is the OAuth token:

```typescript
headers: {
  Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}`,
}
```

This is **NOT** the same as Bearer. Credential endpoints reject Bearer auth.

### Namespace B uses database NAME, not addon UUID

Critical detail: `/postgres/v0/databases/{name}/credentials` takes the **database name** (e.g. `postgresql-dimensional-08540`), not the UUID. Cited in `pg/credentials/create.ts`, `pg/credentials/destroy.ts`, `pg/credentials/repair-default.ts`, `pg/credentials/url.ts`.

---

## There is no probeable "root" endpoint

The current `data.postgres_root` probe hits `HEAD https://api.data.heroku.com/postgres` and expects 200/204. **The real Heroku Data API returns 404 for this path** because there is no root endpoint. The CLI never calls a root; it always calls specific resource paths.

Confirmed live with the real test token:

```
HEAD /postgres                                  → 404
GET /postgres                                   → 404
GET /client/v11                                 → 404
GET /client/v11/databases                       → 404
GET /client/v11/databases/{real-uuid}           → 200 with full JSON
GET /client/v11/databases/{all-zeros-uuid}      → presumably 404 (resource not found)
```

So the probe logic must be redesigned.

---

## Correction 1: `data.postgres_root` probe (REPLACE)

**File:** `packages/core/src/probes.ts`

**Current (broken):**

```typescript
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
```

**Replace with:** probe against a known-nonexistent database UUID, same pattern as the sub-probes. A 404 means "endpoint reachable, no such DB" → tier available.

```typescript
{
  id: 'data.postgres_root',
  tier: 'data.postgres',
  method: 'GET',
  path: '/client/v11/databases/00000000-0000-0000-0000-000000000000',
  base: 'data',
  required: false,
  successCodes: [200, 204, 404],  // 404 = reachable, no such DB = OK
  emptyOkCodes: [],
  forbiddenCodes: [401, 402, 403],  // unauthorized / payment required / forbidden
},
```

**Alternative architectural choice (cleaner but invasive):** remove `data.postgres_root` entirely and have each sub-probe stand alone without `dependsOn`. Each tier becomes independent. This requires updating four sub-probes to remove `dependsOn: 'data.postgres_root'` and removing the root probe and the `tierAvailable('data.postgres')` checks in tool registration. Discuss with David before doing this — it's a meaningful design change.

For now, the minimum fix above keeps the existing architecture.

---

## Correction 2: Sub-probes are correct for `/client/v11/*` paths but `pg.api.credentials` uses the wrong namespace

**File:** `packages/core/src/probes.ts`

**Current `pg.api.credentials` probe:**
```typescript
path: `/client/v11/databases/${PG_PROBE_DB_ID}/credentials`,
```

**Should be:**
```typescript
path: `/postgres/v0/databases/${PG_PROBE_DB_ID}/credentials`,
```

The credentials family lives under `/postgres/v0`, NOT `/client/v11`. Cited in `pg/credentials.ts` (line: `const {body: credentials} = await this.heroku.get<CredentialsInfo>(\`/postgres/v0/databases/${addon.id}/credentials\`, ...`).

**HOWEVER** — `/postgres/v0/*` requires Basic auth, not Bearer. So this probe needs not just a path change but an auth scheme change. The current probe machinery may not support per-probe auth schemes. Two paths forward:

**Option A — extend probe schema with optional `authScheme: 'bearer' | 'basic'`** (default bearer). Probe runner inspects this field and constructs Authorization header accordingly.

**Option B — leave `pg.api.credentials` probing on `/client/v11/databases/{id}/credentials`** if that endpoint exists at all and returns a meaningful status (verify with curl first). The CLI never uses `/client/v11/databases/{id}/credentials` — only `/postgres/v0/databases/{name}/credentials` — so this path may simply 404 unconditionally, which would still work as a probe ("reachable, no such DB") but is semantically wrong.

**Recommendation: Option A.** Adds a small field to the `Probe` type and a branch in the probe runner. Clean. Future-proof for other Basic-auth endpoints.

---

## Correction 3: `pg_credentials_list` tool — wrong path, wrong auth, wrong key

**File:** `packages/postgres-mcp/src/credentials.ts` (or wherever `pg_credentials_list` is implemented)

**Current implementation** (assumed, based on the handoff): calls `GET /client/v11/databases/{addon_id}/credentials` with Bearer auth.

**Correct implementation:** calls `GET /postgres/v0/databases/{db_name}/credentials` with Basic auth.

Cited in `pg/credentials.ts`:

```typescript
const {body: credentials} = await this.heroku.get<CredentialsInfo>(
  `/postgres/v0/databases/${addon.id}/credentials`,  // NB: addon.id works here but the convention is name
  {
    hostname: utils.pg.host(),
    headers: {
      Authorization: `Basic ${Buffer.from(`:${this.heroku.auth}`).toString('base64')}`,
    },
  },
)
```

**IMPORTANT TWO-PART FIX:**

1. **Path:** change `/client/v11/databases/{id}/credentials` → `/postgres/v0/databases/{id_or_name}/credentials`
2. **Auth:** override the default Bearer header with a Basic header. Construct via:
   ```typescript
   `Basic ${Buffer.from(`:${token}`).toString('base64')}`
   ```

The CLI uses `addon.id` interchangeably with `addon.name` in many credential endpoints — both appear to be accepted by the API. Prefer `addon.id` (UUID) for stability; `name` is human-meaningful but mutable.

**Response shape (cited from `pg/credentials.ts`):** `CredentialsInfo[]` — an array of credential objects, each with `name`, `state`, `user`, `password`, etc. Strip secrets before returning to the model — DO NOT include `user`/`password` in the envelope. The current implementation does this stripping per the handoff; just need to make sure it happens after parsing the real response.

---

## Correction 4: `pg_credentials_url` tool — wrong namespace and auth

**File:** `packages/postgres-mcp/src/credentials.ts`

**Real CLI source:** `pg/credentials/url.ts`:

```typescript
const {body: credInfo} = await this.heroku.get<CredentialInfo>(
  `/postgres/v0/databases/${db.name}/credentials/${encodeURIComponent(name)}`,
  {
    hostname: utils.pg.host(),
    headers: {
      Authorization: `Basic ${Buffer.from(`:${this.heroku.auth}`).toString('base64')}`,
    },
  },
)
```

**Tool corrections:**

1. Path: `/postgres/v0/databases/{db_name}/credentials/{credential_name}` (default credential name: `"default"`)
2. Auth: Basic, same construction as Correction 3
3. URI-encode the credential name
4. Response shape: `CredentialInfo` with `database`, `host`, `port`, plus a `credentials` array containing `user`, `state`, `password`. Build the Postgres connection URL from active credentials in the response. Strip the raw password from the returned envelope — return only the constructed `postgres://...` URL.

---

## Correction 5: `pg_backups_*` tools — use APP not DATABASE for some paths

**Critical realization:** Heroku Postgres backups are scoped to the **app**, not the database, for the list/info/url endpoints. The CLI uses `/client/v11/apps/{app}/transfers` paths, NOT `/client/v11/databases/{id}/backups`.

**File:** `packages/postgres-mcp/src/backups.ts`

### `pg_backups_list`

**CLI source:** `pg/backups/index.ts`:

```typescript
const {body: transfers} = await this.heroku.get<BackupTransfer[]>(
  `/client/v11/apps/${app}/transfers`,
  {hostname: utils.pg.host()}
)
```

**Tool correction:** the input schema needs an `app` field (Heroku app name or ID), not just the addon ID. The path is `/client/v11/apps/{app}/transfers`. Auth: Bearer (default).

This is a meaningful schema change — the tool currently takes a `database` parameter (addon ID), but the underlying API takes an `app` parameter. Need to either:
- **Option A:** Add an `app` field to the input schema, optional (defaults to inferring from the database's owning app via Platform API)
- **Option B:** Require `app` as primary input, make `database` optional or remove it

**Recommend Option A.** Users who give a database addon ID still expect the tool to work. The implementation resolves the addon → owning app via Platform API, then calls `/client/v11/apps/{app}/transfers`.

### `pg_backups_info`

**CLI source:** `pg/backups/info.ts` (similar pattern). Path: `/client/v11/apps/{app}/transfers/{num}` where `num` is the backup number (an integer like `b001`).

Tool inputs: `app`, `backup_id` (the `num` value). Same Option A pattern for resolving app from database.

### `pg_backups_url`

**CLI source:** `pg/backups/url.ts`:

```typescript
const {body: info} = await this.heroku.post<PublicUrlResponse>(
  `/client/v11/apps/${app}/transfers/${num}/actions/public-url`,
  {hostname: utils.pg.host()}
)
```

**Tool correction:** path is `/client/v11/apps/{app}/transfers/{num}/actions/public-url`, method is **POST** (not GET). Inputs: `app`, `backup_id`. Returns a temporary public download URL — return the `url` field directly.

### `pg_backups_schedules`

**CLI source:** `pg/backups/schedules.ts`:

```typescript
const {body: schedules} = await this.heroku.get<TransferSchedule[]>(
  `/client/v11/databases/${db.id}/transfer-schedules`,
  {hostname: utils.pg.host()}
)
```

**Tool correction:** this one IS keyed on the database, not the app. Path: `/client/v11/databases/{addon_id}/transfer-schedules`. Method: GET. Bearer auth.

Note the naming inconsistency in Heroku's own API — backups list/info/url are app-scoped (`apps/{app}/transfers`), but schedules are database-scoped (`databases/{id}/transfer-schedules`). Just how it is.

---

## Correction 6: Follower tools — DON'T call a separate endpoint

This is the most invasive correction. The current Phase 6 Part A implementation assumed `pg_followers_list`, `pg_leader`, and `pg_replication_status` each call a separate `/client/v11/databases/{id}/followers` or similar endpoint. **This endpoint does not exist.**

**Reality:** the follower/leader/replication info is part of the standard `GET /client/v11/databases/{id}` response — specifically in the `info` array. The CLI parses the same `info` array for everything `pg:info` displays, including:
- "Following:" (means this DB is a follower; value is the leader's name)
- "Followers:" (means this DB has followers; value lists them)
- "Behind By:" (replication lag in commits)

**Real example response** (captured live from your test DB):

```json
{
  "addon_id": "d53b5949-...",
  "name": "postgresql-dimensional-08540",
  "plan": "essential-0",
  "info": [
    {"name": "Plan", "values": ["essential-0"]},
    {"name": "Status", "values": ["Available"]},
    {"name": "PG Version", "values": ["17.9"]},
    {"name": "Created", "values": ["2026-06-05 02:18 "]},
    {"name": "Data Size", "values": ["7.72 MB / 1 GB (0.75%) (In compliance)"]},
    {"name": "Tables", "values": ["0/4000 (In compliance)"]},
    {"name": "Fork/Follow", "values": ["Unsupported"]},
    {"name": "Rollback", "values": ["Unsupported"]},
    {"name": "Continuous Protection", "values": ["On"]}
  ]
}
```

Note: this is an `essential-0` database, which does NOT support followers (`"Fork/Follow": "Unsupported"`). On `standard-0` and above, the `info` array would include `Following:` (if a follower) or `Followers:` (if a leader with replicas) plus `Behind By:`.

**Tool corrections:**

### `pg_followers_list`, `pg_leader`, `pg_replication_status`

All three should:
1. Internally call `GET /client/v11/databases/{addon_id}` (same path as `pg_info`)
2. Extract the relevant fields from the `info` array
3. Return a structured envelope

Specifically:
- `pg_followers_list` — extract from `info[].name === 'Followers'`. If present, value(s) list the follower names. If absent or `Fork/Follow === 'Unsupported'`, return empty.
- `pg_leader` — extract from `info[].name === 'Following'`. If present, value is the leader's name. If absent, this DB is itself a leader (or unsupported).
- `pg_replication_status` — combine `Following`/`Followers`/`Behind By` info into a coherent status object. If `Fork/Follow === 'Unsupported'`, return "replication unavailable on this plan."

This means the three follower tools share a common helper that calls `pg_info` internally. Consider extracting `getDbInfo(addonId): Promise<PgDatabaseInfo>` to a shared module.

**Don't break the existing `pg_info` shape** — it should still return the full `info` array unmodified. The three follower tools project specific fields out of it.

---

## Correction 7: `pg_diagnostics` tool — completely different host

**CLI source:** `pg/diagnose.ts`:

```typescript
const {body: report} = await this.heroku.post<PGDiagnoseResponse>(
  '/reports',
  {hostname: PGDIAGNOSE_HOST, body}
)
```

The CLI uses a separate `PGDIAGNOSE_HOST` constant (likely `pgdiagnose.herokuapp.com` or similar — need to find the constant value in the CLI source). Plus it requires generating a parameter body that includes connection details and metrics from `/client/v11/databases/{id}/metrics`.

**This is a meaningful piece of work.** The diagnostics endpoint is its own service with its own request shape and response shape, not just a simple API call.

**Tool correction recommendations:**
1. Document `pg_diagnostics` as "not yet implemented; planned for Phase 6 Part C" and remove it from the registered tool list temporarily
2. OR: implement it properly with the separate host + metrics fetch + report POST flow
3. OR: defer entirely until we know the value/usage justifies the complexity

**Recommend: defer.** Mark `pg_diagnostics` as `defer_loading` or just remove it from the registered tools. Diagnostics is a rarely-needed tool and the implementation is non-trivial. Better to ship 15 working tools than 16 tools with one that errors.

---

## Correction 8: `pg_query_insights` tool — needs verification

The handoff explicitly flagged this:
> "the exact pg_backups_url action path, query-stats vs query_insights, schedule path"

The CLI source for `pg:outliers` (the query insights equivalent) actually uses `pg_stat_statements` data accessed via direct database query, not an HTTP API. There may not be a clean Heroku Data API endpoint for query insights.

**Tool correction recommendation:** same as `pg_diagnostics` — defer or remove until we can find a real API endpoint for this data. If it requires direct database connection, that's out of scope for an HTTP-based MCP tool.

**Recommend: defer.**

---

## Correction 9: `pg_maintenance_window` and `pg_connection_pooling` — research needed

Neither has been verified against real CLI source in this handoff. The agent should:

1. For `pg_maintenance_window`: find the CLI command that displays/sets the maintenance window (likely `pg:maintenance:window` or part of `pg:info` output) and use the same endpoint
2. For `pg_connection_pooling`: find the CLI source for `pg:connection-pooling:attach` and any read-only equivalent

If no read-only equivalent exists for connection pooling, defer/remove that tool too.

---

## Correction 10: response-shape verification across all tools

For every tool that survives the corrections above, the agent must:

1. Capture a real example response by curling the actual endpoint against our live test database (addon ID `d53b5949-1fb9-48ae-abc4-cc4f07a6dde7`)
2. Compare to the current zod schema in the tool implementation
3. Adjust the schema to match reality
4. Save the captured response as a fixture file: `packages/postgres-mcp/test/fixtures/{tool-name}.captured.json`

Use these curl commands as templates (substitute the actual token in `$HEROKUMCP_TEST_TOKEN`):

```bash
# pg_info
curl -s -H "Authorization: Bearer $HEROKUMCP_TEST_TOKEN" \
  -H "Accept: application/vnd.heroku+json; version=3" \
  "https://api.data.heroku.com/client/v11/databases/d53b5949-1fb9-48ae-abc4-cc4f07a6dde7"

# pg_credentials_list
curl -s -H "Authorization: Basic $(echo -n ":$HEROKUMCP_TEST_TOKEN" | base64)" \
  -H "Accept: application/vnd.heroku+json; version=3" \
  "https://api.data.heroku.com/postgres/v0/databases/d53b5949-1fb9-48ae-abc4-cc4f07a6dde7/credentials"

# pg_backups_list (requires the app name, not the database UUID)
curl -s -H "Authorization: Bearer $HEROKUMCP_TEST_TOKEN" \
  -H "Accept: application/vnd.heroku+json; version=3" \
  "https://api.data.heroku.com/client/v11/apps/dm-pgtest/transfers"

# pg_backups_schedules
curl -s -H "Authorization: Bearer $HEROKUMCP_TEST_TOKEN" \
  -H "Accept: application/vnd.heroku+json; version=3" \
  "https://api.data.heroku.com/client/v11/databases/d53b5949-1fb9-48ae-abc4-cc4f07a6dde7/transfer-schedules"

# pg_list (lists all postgres addons for the user — uses Platform API, not Data API!)
curl -s -H "Authorization: Bearer $HEROKUMCP_TEST_TOKEN" \
  -H "Accept: application/vnd.heroku+json; version=3" \
  "https://api.heroku.com/addons?service=heroku-postgresql"

# pg_plans (Heroku Platform API)
curl -s -H "Authorization: Bearer $HEROKUMCP_TEST_TOKEN" \
  -H "Accept: application/vnd.heroku+json; version=3" \
  "https://api.heroku.com/addon-services/heroku-postgresql/plans"
```

Note `pg_list` and `pg_plans` use **api.heroku.com** (Platform API), not **api.data.heroku.com**. The current implementation may already be correct for these — confirm.

---

## Correction 11: the live integration test needs to actually verify

**File:** `packages/postgres-mcp/test/integration/postgres.integration.test.ts`

The current test only validates `pg_info`, `pg_credentials_list`, and `pg_backups_list`. After corrections, expand the test to cover all surviving tools (i.e., not `pg_diagnostics`, `pg_query_insights`, possibly `pg_maintenance_window` and `pg_connection_pooling` depending on outcome of Corrections 7-9):

- `pg_list`
- `pg_info`
- `pg_plans`
- `pg_credentials_list`
- `pg_credentials_url`
- `pg_backups_list`
- `pg_backups_info` (may need to capture a backup first)
- `pg_backups_url` (may need an existing backup)
- `pg_backups_schedules`
- `pg_followers_list`
- `pg_leader`
- `pg_replication_status`

For tools that require pre-existing data (backups, followers), the test should either:
- Skip gracefully if the data doesn't exist (`expect(result.isError === true || parseEnv(result).ok === true).toBe(true)`)
- Create the test data first (capture a backup, etc.) — but this is invasive on a real DB

Recommend skip-graceful for now.

---

## Concrete plan for the implementation agent

This is what the agent should do, in order:

1. **Read the entire `packages/postgres-mcp/src/` tree** to understand the current implementation
2. **Read `packages/core/src/probes.ts`** to understand the probe schema and runner
3. **Apply Correction 1** to fix `data.postgres_root`
4. **Apply Correction 2** to fix `pg.api.credentials` probe (with Basic auth support added per Option A)
5. **Apply Correction 3** to fix `pg_credentials_list` (path + auth + response handling)
6. **Apply Correction 4** to fix `pg_credentials_url`
7. **Apply Correction 5** to fix all four `pg_backups_*` tools (app-scoped paths for list/info/url, database-scoped path for schedules)
8. **Apply Correction 6** to refactor follower tools to use `pg_info`'s `info` array
9. **Apply Correction 7-9** to defer/remove `pg_diagnostics`, `pg_query_insights`, and verify `pg_maintenance_window`/`pg_connection_pooling`
10. **Apply Correction 10** to capture real fixtures and align zod schemas
11. **Apply Correction 11** to expand the integration test
12. **Run** `pnpm --filter @heroku-mcp/postgres test:integration` with `HEROKUMCP_TEST_TOKEN` and `HEROKUMCP_TEST_PG_ADDON_ID=d53b5949-1fb9-48ae-abc4-cc4f07a6dde7` set
13. **Iterate** until all tests pass
14. **Run** `pnpm -r build && pnpm -r typecheck && pnpm -r test` to confirm no regressions in unit tests
15. **Commit** changes as a single squashed commit on `main`
16. **Tag** `postgres-v0.1.1` once verified

## Test database for this work

- **App name:** `dm-pgtest`
- **App URL:** `https://dm-pgtest-89e89d80de3a.herokuapp.com/`
- **Database addon name:** `postgresql-dimensional-08540`
- **Database addon UUID:** `d53b5949-1fb9-48ae-abc4-cc4f07a6dde7`
- **Plan:** `essential-0`
- **PG version:** 17.9

Token comes from operator's `~/herokumcp.env` (key `HEROKUMCP_TEST_TOKEN`) on macOS dev machine.

## Things to keep when fixing

These were caught correctly in Phase 6 Part A and shouldn't be regressed:

- ✅ The 4-probe sub-tier design (`pg_credentials`, `pg_backups`, `pg_followers`, `pg_query_insights`)
- ✅ The `extraProbes` parameter on `buildServer()` and its threading through `buildSessionMcp`
- ✅ The `registerPostgresTools()` call sequence after audit-wrapping
- ✅ Sensitive data stripping in `pg_credentials_list` (just needs to happen on real shapes, not assumed shapes)
- ✅ The fixture file convention (`test/fixtures/*.example.json`); rename to `*.captured.json` for real captures

## Things to NOT do in this round

- Don't change the package name from `@heroku-mcp/postgres` (the divergence noted in the original handoff is fine; keep it)
- Don't lift shared helpers from `@heroku-mcp/platform` to `@heroku-mcp/core` yet — that's a Phase 8 hardening task
- Don't add new tools beyond the existing 16 (minus whatever gets deferred)
- Don't change unit test mocks to match the new live shapes — keep unit tests mocking the existing assumed shapes, since the unit tests pass and aren't the focus of this correction round. The integration test is the source of truth for whether reality matches.

Actually, scratch that last one. Unit tests SHOULD be updated to mock the correct real shapes once we capture them. Otherwise unit tests are testing fiction. Update unit test mocks to use captured fixtures from Correction 10.

---

## Final note on the architecture question

While doing this corrections work, the agent will likely notice that **the official Heroku MCP server** at `github.com/heroku/heroku-mcp-server` takes a fundamentally different approach: it shells out to `heroku pg:*` CLI commands rather than calling the API directly. This sidesteps every problem documented above — the CLI already handles namespaces, auth, parsing, and response shaping.

**This is worth a brief mention to David but not a redirect.** The customer-facing 1.0 design explicitly chose direct API calls because:
- HTTP MCP servers don't have shell access in their runtime
- Shelling out requires bundling the `heroku` CLI binary (60+ MB)
- Async-stream parsing of CLI output is fragile compared to typed JSON responses

So we stay on the direct API path. The CLI is our reference for *what* to call, not a runtime dependency.
