# Phase 1 — Divergences from TOOLS.md / ARCHITECTURE.md

A running log of decisions where the implementation departs from (or extends) the design docs. Each entry should record the decision, the reason, and what would need to change in the docs if we want them to agree.

## 1. MCP SDK choice: high-level `McpServer`

**Decision:** Phase 1 uses `@modelcontextprotocol/sdk`'s high-level `McpServer.registerTool(name, config, callback)` API rather than the lower-level `Server` + manual request handler setup.

**Reason:** `registerTool` does JSON-Schema generation from Zod shapes, input validation, and `sendToolListChanged()` for the refresh-capabilities notification we need. The lower-level `Server` would require reimplementing those for marginal flexibility.

**Doc impact:** None. ARCHITECTURE.md is transport-/SDK-agnostic. If Phase 2's destructive-write idiom needs something `McpServer` doesn't expose cleanly, we'll switch at that point and update this note.

## 2. `apps_filter` is GET-semantics but POST-method

**Observation:** TOOLS.md lists `apps_filter` under apps-tier reads. Heroku's endpoint is `POST /filters/apps` with a body. We treat the tool as read-only (no audit-log entry, no confirm guard) since the body is a filter, not a mutation.

**Doc impact:** Worth a sentence in TOOLS.md noting the POST-as-read pattern for the apps_filter, addons_resolve, and app_setups endpoints.

## 3. `telemetry_drains_list` is not per-app

**Observation:** Heroku's `GET /telemetry-drains` returns all telemetry drains visible to the caller, scoped to the token rather than to an app id. TOOLS.md lists this under "Apps → Logs" alongside `log_drains_list`, which is per-app. We expose `telemetry_drains_list` with no `app` parameter, only pagination.

**Doc impact:** TOOLS.md could clarify the scoping difference. The other "telemetry_drains_*" tools listed in TOOLS.md are all writes, deferred to Phase 2.

## 4. `keys_create` deferred

**Observation:** TOOLS.md says `keys_create` is "deprecated by Heroku; surface as note." Phase 1 omits the tool entirely rather than registering a stub that returns a deprecation note. If needed, Phase 2 can land a read-only "deprecated"-marker tool.

## 5. `oauth_tokens_create` deferred

**Observation:** TOOLS.md lists `oauth_tokens_create` under the account tier. It is a POST (a write that creates a new token), so by Phase 1's read-only scope it does not land here. Will be picked up in Phase 2 alongside the other oauth writes.

## 6. `account` tier registration includes diagnostic-only mode

**Observation:** ARCHITECTURE.md §5.2 says delinquent/suspended → "enable diagnostic tools only; hide writes." Phase 1 has no writes regardless, so the practical effect of diagnostic-only mode is "hide every tier-gated read." `registerAllTools` enforces this by returning early after registering the diagnostic set when `isDiagnosticOnly(capabilities)` is true.

## 7. Live integration test gated on `HEROKUMCP_TEST_TOKEN`

**Observation:** `test/integration/platform.integration.test.ts` is the documented Phase 1 smoke test. It is skipped without the env var, matching the pattern set by `packages/core/test/integration/`. The unit tests in `test/tools/*.test.ts` cover the same code paths against a mocked client.

## 8. `audutFileName` typo — fixed

**Observation:** Phase 0 originally shipped the helper as `audutFileName` (missing 'i'). Renamed to `auditFileName` ahead of Phase 2; src and tests updated together. No external consumers exist outside this repo, so the rename is safe.

## 9. Capability cache layout

**Observation:** Per ARCHITECTURE.md §5.3 the file lives at `$HEROKUMCP_HOME/capabilities/<fingerprint>.json`. We store the raw `CapabilityResult` returned by the prober, formatted with 2-space JSON indent. The schemaVersion field guards against silent format drift.

## 10. Tools call signature: argument requirement

**Observation:** When a tool declares an `inputSchema`, the MCP SDK rejects `tools/call` requests that omit `arguments` (even when every property is optional). Tests must pass `arguments: {}` for "no-arg" reads of paginated tools (e.g. `apps_list`). This is SDK behavior, not our convention. Worth flagging if a host gets confused; Claude Desktop sends `arguments: {}` automatically.
