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

---

# Phase 2b divergences

## 18. Phase 2b — `account_delete` is intentionally not implemented

**Observation:** TOOLS.md previously listed `account_delete` (`DELETE /account`) with the `⚠🔒` markers. Phase 2b Decision 1 calls for omitting it. The endpoint requires the user's password as an HTTP header and irreversibly destroys the user's Heroku account; the user should perform this through the Heroku Dashboard. TOOLS.md is updated to document the omission rather than list the tool.

**Doc impact:** None remaining — TOOLS.md now carries the one-line note next to the account tier table.

## 19. Phase 2b — `oauth_tokens_create` deferred (still)

**Observation:** Phase 1 deferred `oauth_tokens_create` because it was a POST (note 5 above). The Phase 2b handoff is explicit that this is not in scope: the endpoint is part of an OAuth-grant flow, primarily used by clients that perform user-facing OAuth, and the Partner MCP will pick it up in Phase 4. Listed in TOOLS.md but not implemented.

## 20. Phase 2b — `account_features_list` is paginated; pagination ships with the read tool

**Observation:** No change vs Phase 1 — flagged here only because the column was reformatted in TOOLS.md. The endpoint remains paginated and the read tool uses the shared pagination helper.

## 21. Phase 2b — `keys_delete` confirm-target is a separate input field

**Observation:** Decision 4 specifies "confirm: <key fingerprint>". The key is identified to Heroku via the URL path (which Heroku accepts as id or fingerprint), but the confirm value must be the fingerprint specifically. To preserve safety even when the caller addresses by id, the tool's input schema takes both `key` (the path argument — id or fingerprint) and `fingerprint` (the confirm target). The model must pass both and the values must agree for the call to be safe. Tests cover the case where the caller supplies a non-fingerprint `key`.

## 22. Phase 2b — `oauth_authorizations_delete` confirm-target is a separate input field

**Observation:** Decision 4 lists confirm as `<id or description>` — the model may identify the authorization by either. We expose a `confirm_target` input that holds the value the user actually used in conversation (either the id or the description). This is then both the expected `confirm` value AND the value shown in the dry-run description. The path still uses `id` (Heroku's only addressable form). Same pattern as note 21.

## 23. Phase 2b — `team_invitations_revoke` pre-fetches via list-and-filter

**Observation:** Per Decision 5, deletes without an individual GET pre-fetch by listing-and-filtering. The implementation calls `GET /teams/{id}/invitations`, finds the entry by matching `user.email` (case-insensitive) or `user.id` (or the entry id itself), and surfaces role + sent-at + sender (`invited_by.email`) in the dry-run description. When no match is found the description says so explicitly, and Heroku is expected to return 404 on the real call.

## 24. Phase 2b — `allowed_addon_services_delete` pre-fetches via list-and-filter

**Observation:** Same shape as note 23. `GET /teams/{id}/allowed-addon-services`, match by `addon_service.name`, `addon_service.id`, or the entry id, surface `added_by.email`.

## 25. Phase 2b — `allowed_addon_services_*` ships with the teams tier (not addons_consumer)

**Observation:** TOOLS.md originally listed these three tools under `addons_consumer`, but the endpoints they wrap (`POST/GET/DELETE /teams/{id}/allowed-addon-services`) are team-scoped and naturally gated by the teams probe. The capability matrix for `addons_consumer` is gated separately and is Phase 3 scope. We ship them with the teams tier (and gate them on `teams.list`); the addons_consumer table now carries a one-line note pointing to the teams tier for these tools.

## 26. Phase 2b — `teams_create` and `teams_delete` carry deprecation context in their MCP descriptions

**Observation:** Decision 2 calls for verbatim-or-close deprecation context in the tool descriptions: "the Heroku CLI removed its `teams:create` / `teams:destroy` commands because Heroku now recommends managing teams through an Enterprise account dashboard. The Platform API endpoints still work and create/destroy standalone (non-enterprise) teams." We embed this in the `description` field returned by `tools/list` so MCP hosts and the model both see it before invoking the tool. Unit tests assert that the substrings "CLI", "Enterprise", and "standalone" appear in the descriptions.

## 27. Phase 2b — teams tier lights up on empty `200 []`

**Observation:** Decision 7. We rely on the prober's existing `emptyOkCodes` handling — 204 / 404 already classify as "empty" in the prober; for `teams.list`, an empty array body returns 200 with `Content-Range: id 0..0; max=...; total=0`, which lands on the standard success path. The `tierAvailable` check therefore returns true regardless of team count. The unit test fixture covers both the "200 with one team" and "tier marked available with no teams in tiers" cases.

## 28. Phase 2b — teams probe was already in place

**Observation:** The `teams.list` probe was specified in CAPABILITY_PROBES.md and wired in `packages/core/src/probes.ts` in Phase 1. Phase 1 did not register any teams-tier tools, so the probe ran but had no effect on `tools/list`. Phase 2b populates the registration site (`packages/platform-mcp/src/tools/index.ts`) without modifying the probe definition.

## 29. Phase 2b — apps_create and apps_filter remain Phase 1/2a, not Phase 2b

**Observation:** The Phase 2b handoff explicitly notes that team-owned apps are deleted via the existing `apps_delete` tool from Phase 2a (it accepts any app id/name, team-owned or not). We did not duplicate `apps_delete` into a `team_apps_delete` and `team_apps_create` is implemented as a separate tool only because it has a different path (`POST /teams/apps`) and different parameters (`team` is required).

## 30. Phase 2b — `team_apps_transfer` confirm-targets the app, not the recipient

**Observation:** Decision 3 maps `team_apps_transfer` to `confirm: <app name>` — the app being transferred is the destructive target, not the new owner. The tool body builds a single PATCH with `{owner}` in the body (no extra `team_apps_update_locked` overlap). This intentionally splits the tool from `team_apps_update_locked` to give the model a clear semantic distinction: locking is reversible, ownership change is not.

## 31. Phase 2b — `account_sms_number_recover` accepts an empty input schema

**Observation:** The endpoint takes no inputs. To keep the `registerWriteTool` shape consistent (which always injects `dry_run` and the optional `confirm`), the tool declares `inputSchema: {}`. This is valid in zod and the SDK; the MCP `tools/list` payload reports the dry_run flag as the only optional input.

## 32. Phase 2b — final tool count

Phase 2b adds:

  Account writes (11):  account_update, account_features_update, account_sms_number_recover,
                        keys_create, keys_delete, oauth_authorizations_create,
                        oauth_authorizations_delete, oauth_authorizations_regenerate,
                        invoice_address_update, credits_create, user_preferences_update
  Teams reads (20):     teams_list, teams_info, team_members_list, team_members_apps_list,
                        team_apps_list, team_apps_info, team_app_collaborators_list,
                        team_app_permissions_list, team_invitations_list, team_invoices_list,
                        team_invoices_info, team_daily_usage, team_monthly_usage,
                        team_features_list, team_features_info, team_addons_list,
                        allowed_addon_services_list, team_preferences_get, team_spaces_list,
                        team_delinquency_info
  Teams writes (18):    teams_create, teams_update, teams_delete,
                        team_members_create_or_update, team_members_delete,
                        team_apps_create, team_apps_update_locked, team_apps_transfer,
                        team_app_collaborators_create, team_app_collaborators_update,
                        team_app_collaborators_delete,
                        team_invitations_create, team_invitations_accept, team_invitations_revoke,
                        team_features_update, team_preferences_update,
                        allowed_addon_services_create, allowed_addon_services_delete

Total Phase 2b: **49 new tools** (11 account writes + 20 teams reads + 18 teams writes).
Total tools shipped to date: **152** (103 from Phase 1 + 2a, plus 49 Phase 2b).

---

# Phase 3 divergences

## 34. Phase 3 — tier names align with the existing prober (no new probes added)

**Observation:** The four Phase 3 tier probes (`enterprise.list`, `spaces.list`, `addons.list`, `pipelines.list`) were already defined in `packages/core/src/probes.ts` from Phase 0. Phase 3 wired the existing probes into `packages/platform-mcp/src/tools/index.ts` via four new `tierAvailable` checks (`enterprise`, `spaces`, `addons_consumer`, `pipelines`). No probe definitions or prober behaviour changed. The new `prober.test.ts` block exercises each Phase 3 probe against the standard response classes (200, 200-empty, 401, 402, 403, 404, 429, timeout) as required by the handoff acceptance criteria.

**Doc impact:** None — CAPABILITY_PROBES.md and ARCHITECTURE.md §5 already describe these probes.

## 35. Phase 3 — enterprise tool names follow the handoff prompt (not the older TOOLS.md draft)

**Observation:** TOOLS.md's enterprise tier was drafted with `enterprise_account_info`, `enterprise_account_update`, `enterprise_members_list`, etc. The Phase 3 handoff prompt named the tools `enterprise_accounts_info`, `enterprise_accounts_update`, `enterprise_account_members_list`, etc. — pluralising the resource segment and lifting the per-resource action to `account_members_*` form. We use the handoff prompt's names since it carries the most recent design decisions; TOOLS.md was updated to match in this phase. The endpoints are unchanged.

## 36. Phase 3 — Decision 2: pipeline promotion is non-destructive

**Observation:** Phase 3 Decision 2 specifies that `pipelines_promote` and `pipelines_promote_to_new` accept `dry_run` but do NOT require `confirm`. Promotion is the normal CI/CD flow; gating every promotion on a verbal confirm would be hostile UX. The dry-run preview surfaces source app → target app(s) so the user can see what's being promoted before the real call.

**Doc impact:** TOOLS.md updated to drop the `⚠` marker on `pipelines_promote_create` (now `pipelines_promote`).

## 37. Phase 3 — Decision 5: Shield spaces require `log_drain_url` at creation time

**Observation:** When `spaces_create` is called with `shield: true`, the `log_drain_url` parameter MUST be provided — Heroku permanently disables log-drain support on Shield spaces created without one (the drain cannot be added later). The schema enforcement lives inside `build()` so the validator runs on both dry-run and real-call paths and throws a typed `InvalidParamsError` with `fields: ['log_drain_url']` and a message that references the docs guidance verbatim ("Use https://localhost as a placeholder if you don't yet have a real drain URL"). Tested in `spaces.test.ts` ("spaces_create REJECTS shield=true without log_drain_url").

**Doc impact:** TOOLS.md updated with a one-line annotation next to `spaces_create`.

## 38. Phase 3 — pipeline_couplings_destroy confirm-targets the parent pipeline name

**Observation:** Pipeline-coupling ids are opaque UUIDs that wouldn't capture user intent. The `pipeline_couplings_destroy` tool prefetches the coupling, then resolves the confirm target to `coupling.pipeline.name` — the human-readable pipeline name. This matches the Phase 2b fix pattern (canonical name from prefetch, not args).

## 39. Phase 3 — addon_webhooks_delete confirm-targets the parent add-on name

**Observation:** Webhook URLs are not user-friendly identifiers (e.g. arbitrary HTTPS endpoints). `addon_webhooks_delete` prefetches the parent add-on (`GET /addons/{addon}`) rather than the webhook itself, so the confirm target is the add-on name. The webhook is identified by its UUID path segment on the DELETE request.

## 40. Phase 3 — addons_resolve and addon_attachments_resolve treated as reads

**Observation:** Both endpoints are `POST` (the body is a filter — Heroku rejects search params in URLs). They're registered as plain reads, not write tools: no audit log entry, no confirm guard, no dry_run. Same pattern as Phase 1's `apps_filter` and `app_setups_create` (see note #2). The catalog endpoints `addon_services_list` / `addon_plans_list` / `addon_regions_list` are similarly read-only.

## 41. Phase 3 — sso_token_for_addon is a read despite POST verb

**Observation:** `POST /addons/{id}/sso` returns a one-time SSO URL for the partner's dashboard. No Heroku-side state changes. We mark the tool `readOnlyHint: true` and don't audit it as a mutation. The tool description carries the "marked read-style despite the POST verb" note so reviewers can verify.

## 42. Phase 3 — `credit_pool_info` exposed best-effort

**Observation:** TOOLS.md doesn't list `credit_pool_info` explicitly. The handoff prompt mentioned it conditionally ("if exposed in Heroku's enterprise API"). We expose it under the path `GET /enterprise-accounts/{id_or_name}/credit-pool`. Heroku returns 404 when the credit-pool resource is not enabled on the account's plan — the tool surfaces that as a typical not_found envelope without throwing. The tool description carries this fallback semantics.

## 43. Phase 3 — `addon_actions_run` description warns about per-service availability

**Observation:** Heroku's `POST /addons/{id}/actions/{action}` only works for add-on services that publish actions. Most services don't (and the endpoint returns 404). The tool description tells the model to call `addon_actions_list` on the parent service first to discover available actions. The body parameter is `Record<string, unknown>` (passed through verbatim to the partner), since action semantics are vendor-defined.

## 44. Phase 3 — final tool count

Phase 3 adds tools across four tiers:

  Enterprise (15):   enterprise_accounts_list, enterprise_accounts_info, enterprise_account_daily_usage,
                     enterprise_account_monthly_usage, enterprise_account_members_list,
                     enterprise_account_member_apps_list, enterprise_account_permissions_list,
                     enterprise_account_addons_list, enterprise_account_teams_list, credit_pool_info,
                     enterprise_accounts_update, enterprise_account_members_create_or_update,
                     enterprise_account_members_delete, enterprise_account_teams_create,
                     enterprise_account_teams_update

  Spaces (23):       spaces_list, spaces_info, spaces_app_access_list, spaces_nat_info,
                     spaces_inbound_ruleset_current, spaces_outbound_ruleset_current,
                     spaces_inbound_rulesets_list, spaces_outbound_rulesets_list,
                     vpn_connections_list, vpn_connections_info, peerings_list, peerings_info,
                     space_transfer_list, spaces_create, spaces_update, spaces_destroy,
                     vpn_connections_create, vpn_connections_destroy, peerings_create,
                     peerings_destroy, space_transfer_create, spaces_inbound_ruleset_create,
                     spaces_outbound_ruleset_create

  Add-ons (28):      addons_list, addons_info, addons_resolve, addon_services_list,
                     addon_services_info, addon_attachments_list, addon_attachments_info,
                     addon_attachments_resolve, addon_config_get, addon_actions_list,
                     addon_regions_list, addon_plans_list, addon_plans_info,
                     addon_webhooks_list, addon_webhooks_info, sso_token_for_addon,
                     addons_create, addons_update, addons_destroy,
                     addons_provision_release_test_resource, addons_promote_to_release,
                     addon_attachments_create, addon_attachments_destroy, addon_config_update,
                     addon_actions_run, addon_webhooks_create, addon_webhooks_update,
                     addon_webhooks_delete

  Pipelines (22):    pipelines_list, pipelines_info, pipeline_couplings_list,
                     pipeline_couplings_info, pipeline_couplings_by_app, pipeline_releases_list,
                     pipeline_promotions_list, pipeline_promotions_info,
                     pipeline_promotion_targets_list, pipeline_deployments_list,
                     pipeline_review_app_config_info, pipelines_create, pipelines_update,
                     pipelines_destroy, pipeline_couplings_create, pipeline_couplings_update,
                     pipeline_couplings_destroy, pipelines_promote, pipelines_promote_to_new,
                     pipeline_transfer, pipeline_review_app_config_update,
                     pipeline_review_apps_enable

Total Phase 3: **88 new tools** (15 enterprise + 23 spaces + 28 addons + 22 pipelines).
Total tools shipped to date: **240** (152 from Phase 1 + 2a + 2b, plus 88 Phase 3).

## 33. Phase 2b fix — confirm pattern uses canonical name from prefetched resource, not input arg

**Observation:** Original Phase 2a / 2b design: `confirm` matched whatever was passed as `args.<id-field>`. Bug surfaced in the Phase 2b Claude Desktop acceptance test: when Claude resolves a resource to its UUID internally and passes the UUID as input, the confirm guard then demanded the UUID as `confirm` — but the user typed the human-readable name in conversation. That defeats the purpose of the gate, which is supposed to capture "the user explicitly typed this canonical identifier."

**Fix:** Extract the expected confirm value from the prefetched response's canonical identifier field (`resource.name` for apps/teams/dynos/pipelines/sni endpoints, `resource.user.email` for collaborators/invitations, `resource.email` for team members, `resource.fingerprint` for SSH keys, `resource.hostname` for domains, `resource.id` for telemetry drains and review apps which lack human names, `resource.description ?? resource.id` for oauth authorizations). The destructive spec in `packages/platform-mcp/src/write-tool.ts` now takes `expectedFromResource(resource) => string | undefined` (preferred) and `expectedFromArgs(args) => string` (fallback). The pre-fetch now also runs on the real-call path (not just dry-run) so the gate has a canonical resource to derive from. For tools whose pre-fetch is list-and-filter (`team_invitations_revoke`, `allowed_addon_services_delete`), `expectedFromArgs` is the safe fallback when the entry is no longer present.

Tools that previously had no pre-fetch but needed one for this fix gained one: `apps_disable_acm`, `dynos_restart`, `dynos_restart_all`, `dynos_stop`, `releases_rollback`, `builds_delete_cache`, `log_drains_delete` (switched from drain-prefetch to app-prefetch since confirm is on the app name), `app_webhooks_delete` (same switch), `app_transfers_update`, `team_apps_transfer`, `review_apps_config_delete`, `oauth_authorizations_regenerate`.

**Doc impact:** PHASE-2a.md (Decision 1) and PHASE-2b.md (Decisions 3 & 4) carry post-fix notes pointing to this entry.
