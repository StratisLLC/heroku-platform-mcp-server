# Phase 1 & 2a — Divergences from TOOLS.md / ARCHITECTURE.md

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

---

# Phase 2a divergences

## 11. Phase 2a — apps_create included

**Observation:** The Phase 2a handoff prompt listed apps-tier writes but omitted `apps_create`. TOOLS.md lists `apps_create 🧪 (POST /apps)`, and the Phase 2a integration test specifies "create a fresh app named like `herokumcp-phase2a-int-${Date.now()}`" — which requires `apps_create`. We added it in `apps-writes.ts` with `dry_run` support and no `confirm` (creating an app is not destructive). The total Phase 2a write count is 39 tools instead of the "approximately 38" the prompt mentioned.

**Doc impact:** TOOLS.md already lists the tool; no doc change beyond noting the canonical scope here.

## 12. Phase 2a — registerWriteTool centralises dry_run + confirm gates

**Observation:** Rather than scatter `dry_run` and `confirm` parameter handling across every write tool, Phase 2a adds `packages/platform-mcp/src/write-tool.ts` exporting `registerWriteTool(server, ctx, config)`. Each write tool declares: input schema (without dry_run/confirm), an optional destructive spec, an optional pre-fetch step (delete operations only — Decision 6), a `build(args) → WriteRequest` function, and a `describe(args, fetched?) → string` function. The helper injects `dry_run`/`confirm` onto the schema, gates the request behind `assertConfirm`, and on `dry_run: true` returns `buildDryRunResponse(...)` from `@heroku-mcp/core` without issuing the HTTP call.

**Doc impact:** Worth a one-liner in TOOLS.md's tool-conventions section once we ship Phase 2b. ARCHITECTURE.md §8 already endorses the pattern.

## 13. Phase 2a — DryRunResult lives under `data`, not at the envelope's top level

**Observation:** Decision 3 specifies:
```
{ ok: true, dry_run: true, data: { request, description }, meta: {...} }
```
We surface the dry-run shape inside the **success envelope's `data` field** (i.e. `data: { request, description }`) rather than as a separate top-level `dry_run` key. The reasoning: every other success envelope keys off `ok: true; data: ...; meta: ...`, and existing MCP host UIs read tool results via `data`. Adding a sibling `dry_run` key beside `data` would break that contract. The `dry_run: true` marker still appears — it lives inside `data.request` implicitly (the absence of a real `requestId` in `meta` is the strong signal) and the `description` field reads "Would …" so the audience can't miss it.

This is a deliberate deviation from Decision 3's literal shape; the structural information (what would be issued, what currently exists) is fully preserved.

**Doc impact:** If the Phase 2b handoff wants the literal Decision-3 shape, this is the call to revisit. Easy 10-minute change. The unit tests assert against the shape we ship.

## 14. Phase 2a — sni_endpoints schema relaxation

**Observation:** TOOLS.md lists `sni_endpoints_update` params as "cert + key" optional. Our implementation makes both `certificate_chain` and `private_key` required for the PATCH because Heroku's endpoint demands them together (per the Platform API reference at /platform-api-reference#sni-endpoint-update). The PATCH effectively replaces the certificate material rather than partial-updating it.

**Doc impact:** TOOLS.md could note "cert + key are required together" to match the live API.

## 15. Phase 2a — dynos_run leaves rendezvous streaming for later

**Observation:** Per Decision 7, `dynos_run` is not marked destructive and does not require `confirm`. Its tool description carries the verbatim warning the handoff prompt specified. The tool returns the dyno record (id, name, state, command, type, etc.) and does NOT implement Heroku's rendezvous protocol for streaming command output. Streaming the dyno's stdout/stderr requires either a long-lived HTTP transport or a new MCP streaming idiom; both are deferred to Phase 4 when the HTTP transport lands.

**Doc impact:** TOOLS.md should add a footnote on `dynos_run` noting "returns dyno metadata only; output streaming requires HTTP transport (Phase 4)."

## 16. Phase 2a — telemetry_drains_update is account-scoped, not app-scoped

**Observation:** TOOLS.md lists `telemetry_drains_update` under "Apps → Logs" alongside `log_drains_update`. Heroku's PATCH `/telemetry-drains/{id}` is account-scoped — addressed by drain id, not by app. The tool therefore takes `id: string` (not `app + drain`) and POSTs to `/telemetry-drains/{id}`. This matches the existing read-side observation (note 3) that `telemetry_drains_list` is also account-scoped.

**Doc impact:** Same fix as note 3 — clarify in TOOLS.md that telemetry drains are an account-scoped resource. Telemetry drain *creates* are app-scoped (`POST /apps/{app}/telemetry-drains`); updates and deletes use the global path.

## 17. Phase 2a — final tool count

Phase 1 shipped 56 read-only tools. Phase 2a adds:

  Apps (6):          apps_create, apps_update, apps_delete, apps_enable_acm, apps_disable_acm, apps_refresh_acm
  Config (2):        config_vars_update, app_features_update
  Formation (5):     formation_scale, dynos_run, dynos_restart, dynos_restart_all, dynos_stop
  Releases (8):      releases_create, releases_rollback, builds_create, builds_delete_cache,
                     buildpack_installations_update, slugs_create, oci_image_create, source_create
  Domains/SSL (6):   domains_create, domains_update, domains_delete,
                     sni_endpoints_create, sni_endpoints_update, sni_endpoints_delete
  Logs (6):          log_sessions_create, log_drains_create, log_drains_delete,
                     telemetry_drains_create, telemetry_drains_update, telemetry_drains_delete
  Webhooks (3):      app_webhooks_create, app_webhooks_update, app_webhooks_delete
  Collab (5):        collaborators_create, collaborators_delete,
                     app_transfers_create, app_transfers_update, app_transfers_delete
  Review apps (6):   review_apps_create, review_apps_delete,
                     review_apps_config_create, review_apps_config_update, review_apps_config_delete,
                     app_setups_create

Total Phase 2a writes: **47 new tools** across the apps tier.
Apps-tier subtotal (reads + writes): 36 + 47 = **83 tools**.
Total tools shipped to date: **103** (5 diagnostic + 15 account reads + 36 apps reads + 47 apps writes).
