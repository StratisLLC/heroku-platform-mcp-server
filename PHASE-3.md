# Phase 3 — Handoff Prompt for Claude Code

> Drop into the repo at `PHASE-3.md`. Open a **fresh** Claude Code session and paste the prompt block. Do not continue any previous session.

## What Phase 3 is

The final customer-side surface phase. Adds four new capability tiers:

- **Enterprise** (~22 tools) — enterprise account management, members, permissions, usage reporting
- **Spaces** (~18 tools) — Private Spaces lifecycle, VPN, peering, NAT, transfer keys
- **Add-ons** (~26 tools) — add-on catalog browsing, provisioning, attachments, actions
- **Pipelines** (~22 tools) — pipeline lifecycle, couplings, promotions, review-app config

**~88 new tools.** After Phase 3 lands, total tool count will be ~240.

By the time this phase finishes, the platform MCP will be feature-complete for read/write tooling. Phase 4+ is about *how* it gets to users (HTTP transport, OAuth, hosting), not *what* it does.

All work reuses existing patterns:
- `registerWriteTool` from Phase 2a (writes)
- Confirm + dry_run safety primitives from Phase 2a
- Canonical-name confirm extraction from the Phase 2b fix
- Pagination helper from `@heroku-mcp/core`
- Probe matrix data in `packages/core/src/probes.ts`

## Prerequisites

```bash
cd /Users/maxpro/Desktop/Github/herokumcp
git status                                  # clean working tree
git log --oneline | head -5
# Should show recent commits ending at tag platform-v0.3.0

pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r format:check && pnpm -r test
# All green — 242 core + 151 platform = 393 tests

pnpm -r test:integration
# All green (with HEROKUMCP_TEST_TOKEN exported)
```

## Test environment setup

You'll need:

1. **Enterprise account access:** You already have access to `heroku-demo` and `stratisglobal`. Phase 3 enterprise tests will exercise read-only operations against these.

2. **A pipeline:** Free to create. Either pre-create one named `herokumcp-phase3-test`, or let the integration test create and destroy one.

3. **An app with an add-on:** Heroku Postgres mini ($5/mo) or a free add-on like Heroku Scheduler. Pre-attach one to an existing test app, or let the integration test do it.

4. **Private Spaces:** Phase 3 acceptance test uses your existing `herokumx`-owned spaces for read operations. Create/destroy is exercised by integration tests only (no real space creation in the Claude Desktop walkthrough due to 8-10 minute provisioning latency).

Pre-create pipeline (recommended):

```bash
heroku pipelines:create herokumcp-phase3-test --stage staging
heroku create herokumcp-phase3-staging --team herokumcp-phase2b-test --region us
heroku pipelines:add herokumcp-phase3-test --app herokumcp-phase3-staging --stage staging
```

Or skip this and let Phase 3's integration test create and clean up its own pipeline. The Claude Desktop walkthrough is more interesting with a pre-existing pipeline to look at.

---

## The prompt to paste into a fresh Claude Code session

```
Phase 2b is complete and tagged at platform-v0.3.0 with the confirm-pattern fix landed. All CI is green. Begin Phase 3 per ARCHITECTURE.md §15 and the decisions captured below.

Read these documents in this order before writing any code:

  1. ARCHITECTURE.md §5 (capability discovery) and §8 (tool conventions)
  2. TOOLS.md sections for the four Phase 3 tiers: enterprise, spaces, addons, pipelines
  3. CAPABILITY_PROBES.md — four new probes to wire up
  4. NAMING.md — naming conventions remain (HEROKUMCP_*, @heroku-mcp/* npm scope unchanged)
  5. notes/divergences.md — Phase 3 will likely add more entries
  6. PHASE-2b-fix.md — the canonical-name confirm pattern, which all Phase 3 destructive tools must follow

Then explore packages/platform-mcp/src/tools/*.ts and packages/platform-mcp/src/write-tool.ts. Every read tool in Phase 3 mirrors Phase 1's apps/account tier patterns. Every write tool mirrors Phase 2a/2b's registerWriteTool usage. Pagination is required for every list endpoint.

============================================================
DESIGN DECISIONS — authoritative for Phase 3
============================================================

DECISION 1 — Single enterprise tier
------------------------------------
One capability tier called `enterprise`, gated on `GET /enterprise-accounts` returning ≥1 entry. Per-endpoint permission errors (401, 403) flow through naturally. We don't probe for permissions sub-levels (admin vs collaborator vs viewer); Heroku reports those in individual responses.

DECISION 2 — Pipeline promotion is NOT destructive
---------------------------------------------------
`pipelines_promote` and `pipelines_promote_to_new` accept `dry_run` but do NOT require `confirm`. Promotion is the normal CI/CD flow; requiring confirm every time would be hostile UX. The dry-run preview should show source app → target app(s) so the user sees what's being promoted.

DECISION 3 — Spaces follow the canonical-name pattern
------------------------------------------------------
`spaces_destroy` ⚠ requires confirm matching the space's `name` field from prefetched `GET /spaces/{id}` response. Same pattern as apps_delete. No exceptions.

DECISION 4 — Expose `addons_resolve`
-------------------------------------
The endpoint `POST /actions/addons/resolve` finds an add-on by name across all apps the user has access to. Implement as `addons_resolve` — non-destructive, useful for "find my heroku-postgres add-on" without specifying the app.

DECISION 5 — Shield spaces require `log_drain_url`
---------------------------------------------------
When `spaces_create` is called with `shield: true`, the `log_drain_url` parameter MUST be provided. Otherwise the space is created without log-drain support PERMANENTLY (Heroku doesn't let you add one later).

Schema enforcement: when `shield: true`, validate that `log_drain_url` is a non-empty string. Reject the call with a clear error if not.

Tool description: include this guidance verbatim:

  "Shield-type private spaces require a log_drain_url at creation time. If you don't have a drain URL configured yet, use https://localhost as a placeholder — you can update it later via log_drains_create. Omitting log_drain_url on a Shield space permanently disables log-drain support on that space."

DECISION 6 — Spaces tier acceptance test does NOT exercise create/destroy in Claude Desktop
--------------------------------------------------------------------------------------------
Private Space provisioning takes 8-10 minutes. The Claude Desktop walkthrough at the end of Phase 3 will exercise spaces READ operations against pre-existing spaces only. The spaces create/destroy code paths are exercised by the integration test, which can wait synchronously for the 10-minute provisioning.

============================================================
TOOLS TO IMPLEMENT IN PHASE 3
============================================================

ENTERPRISE TIER (~22 tools):

Reads:
- enterprise_accounts_list (paginated)
- enterprise_accounts_info
- enterprise_account_daily_usage
- enterprise_account_monthly_usage
- enterprise_account_members_list (paginated)
- enterprise_account_member_apps_list
- enterprise_account_permissions_list
- enterprise_account_addons_list (paginated)
- enterprise_account_teams_list (paginated)
- credit_pool_info (if exposed in Heroku's enterprise API)

Writes:
- enterprise_accounts_update — dry_run, no confirm
- enterprise_account_members_create_or_update (PUT) — dry_run, no confirm
- enterprise_account_members_delete ⚠ — confirm: member email (from prefetch)
- enterprise_account_teams_create — dry_run, no confirm. NEW: this is the API path for enterprise team creation that Phase 2b's teams_create deferred. Reference Phase 2b's deprecation context in this tool's description — clarify that this is the recommended path for enterprise users.
- enterprise_account_teams_update — dry_run, no confirm

Refer to TOOLS.md for the canonical list. If TOOLS.md is missing tools that are documented in Heroku's Platform API reference, add them and log a divergence note.

SPACES TIER (~18 tools):

Reads:
- spaces_list (paginated)
- spaces_info
- spaces_app_access_list
- spaces_nat_info
- spaces_inbound_ruleset_current
- spaces_outbound_ruleset_current
- spaces_inbound_rulesets_list
- spaces_outbound_rulesets_list
- vpn_connections_list
- vpn_connections_info
- peerings_list
- peerings_info
- space_transfer_list

Writes:
- spaces_create — dry_run, no confirm; SPECIAL: schema enforces log_drain_url when shield=true (Decision 5)
- spaces_update — dry_run, no confirm
- spaces_destroy ⚠ — confirm: space name (from prefetched /spaces/{id})
- vpn_connections_create — dry_run, no confirm
- vpn_connections_destroy ⚠ — confirm: vpn name (from prefetched /spaces/{space_id}/vpn-connections/{id})
- peerings_create — dry_run, no confirm
- peerings_destroy ⚠ — confirm: peering pcx_id (from prefetched /spaces/{space_id}/peerings/{id})
- space_transfer_create — dry_run, no confirm
- spaces_inbound_ruleset_create — dry_run, no confirm (creates new ruleset as current)
- spaces_outbound_ruleset_create — dry_run, no confirm

ADD-ONS TIER (~26 tools):

Reads:
- addons_list (paginated)
- addons_info
- addons_resolve (POST /actions/addons/resolve — see Decision 4)
- addon_services_list (paginated)
- addon_services_info
- addon_attachments_list (paginated)
- addon_attachments_info
- addon_attachments_resolve (POST /actions/addon-attachments/resolve)
- addon_config_get
- addon_config_update — actually this is a write, see below
- addon_actions_list (per-service, varies by add-on)
- addon_regions_list
- addon_plans_list (paginated)
- addon_plans_info

Writes:
- addons_create — dry_run, no confirm
- addons_update — dry_run, no confirm
- addons_destroy ⚠ — confirm: add-on name from prefetched /addons/{id}
- addons_provision_release_test_resource — dry_run, no confirm
- addons_promote_to_release — dry_run, no confirm
- addon_attachments_create — dry_run, no confirm
- addon_attachments_destroy ⚠ — confirm: attachment name from prefetched /addon-attachments/{id}
- addon_config_update — dry_run, no confirm
- addon_actions_run — dry_run, no confirm. SPECIAL: the action is identified by service+name; the description should surface what action is being run.
- addon_webhooks_list (paginated)
- addon_webhooks_info
- addon_webhooks_create — dry_run, no confirm
- addon_webhooks_update — dry_run, no confirm
- addon_webhooks_delete ⚠ — confirm: addon name (parent prefetch from /addons/{id}; webhook URLs are not user-friendly identifiers)
- sso_token_for_addon (POST /addons/{id}/sso) — non-destructive but produces a one-time SSO URL; treat as a read despite POST verb (mark explicitly)

PIPELINES TIER (~22 tools):

Reads:
- pipelines_list (paginated)
- pipelines_info
- pipeline_couplings_list (paginated)
- pipeline_couplings_info
- pipeline_couplings_by_app
- pipeline_releases_list (paginated)
- pipeline_promotions_list (paginated)
- pipeline_promotions_info
- pipeline_promotion_targets_list
- pipeline_deployments_list (paginated)
- pipeline_review_app_config_info

Writes:
- pipelines_create — dry_run, no confirm
- pipelines_update — dry_run, no confirm
- pipelines_destroy ⚠ — confirm: pipeline name (from prefetched /pipelines/{id})
- pipeline_couplings_create — dry_run, no confirm
- pipeline_couplings_update — dry_run, no confirm
- pipeline_couplings_destroy ⚠ — confirm: pipeline name (from prefetched /pipeline-couplings/{id})
- pipelines_promote — dry_run, no confirm (Decision 2)
- pipelines_promote_to_new — dry_run, no confirm (Decision 2). The description should show source app → target NEW app being created.
- pipeline_transfer — dry_run, no confirm
- pipeline_review_app_config_update — dry_run, no confirm
- pipeline_review_apps_enable — dry_run, no confirm

NOTE: review_apps_* (individual review apps) are in the APPS tier and were implemented in Phase 2a. Phase 3 adds pipeline-LEVEL operations around review apps (the pipeline-wide config that governs which review apps get created).

============================================================
IMPLEMENTATION SEQUENCE
============================================================

1. Add four new probes to packages/core/src/probes.ts:
   - enterprise.list → GET /enterprise-accounts
   - spaces.list → GET /spaces
   - addons.list → GET /addons
   - pipelines.list → GET /pipelines
   Each probe interprets a 200 with empty array as available: true. The Phase 2b teams.list probe established this pattern; mirror it.

2. Update packages/platform-mcp/src/capabilities.ts to gate each new tier.

3. Add unit tests for each new probe in packages/core/test/prober.test.ts covering 200, 200-with-empty-array, 401, 402, 403, 404, 429, and timeout cases.

4. Implement each tier's read tools, organized by file:
   - packages/platform-mcp/src/tools/enterprise.ts
   - packages/platform-mcp/src/tools/spaces.ts
   - packages/platform-mcp/src/tools/addons.ts
   - packages/platform-mcp/src/tools/pipelines.ts
   
   All paginated list endpoints use the rangeHeader helper from packages/core.

5. Implement each tier's write tools using registerWriteTool:
   - packages/platform-mcp/src/tools/enterprise-writes.ts
   - packages/platform-mcp/src/tools/spaces-writes.ts
   - packages/platform-mcp/src/tools/addons-writes.ts
   - packages/platform-mcp/src/tools/pipelines-writes.ts

6. Wire all new tools into packages/platform-mcp/src/tools/index.ts, gated by the appropriate tier from capabilities.

7. Implement Decision 5 (Shield space log-drain enforcement):
   - In spaces_create, use a zod refinement that validates log_drain_url is a non-empty string when shield is true
   - The error message should reference the docs guidance
   - Test case: spaces_create with shield: true and no log_drain_url should fail schema validation; with shield: true and log_drain_url: "https://localhost" should succeed (and pass through to the API)

8. For every destructive tool, ensure unit tests cover:
   - Missing confirm → confirmation_required error
   - Confirm matching args.<id-field> but NOT matching prefetched resource's canonical name → REJECTED (this is the Phase 2b fix in action)
   - Confirm matching prefetched canonical name → success
   - dry_run: true without confirm → preview returned

9. Extend the integration test in packages/platform-mcp/test/integration/platform.integration.test.ts with FOUR new lifecycle scenarios:

   a. Enterprise tier: list enterprise accounts, list members, fetch monthly usage report. Read-only against heroku-demo.

   b. Spaces tier: 
      - List existing spaces (read-only).
      - OPTIONAL: if HEROKUMCP_TEST_SPACE_CREATE is set in env, create a Shield space with log_drain_url: "https://localhost", wait for state: "allocated" (poll with timeout, max 12 minutes), then destroy it.
      - SKIP the optional creation if the env var is not set. The basic read tests should always run.

   c. Add-ons tier: list add-ons, list services, create a free add-on (Heroku Scheduler) on a scratch app, fetch its config, list webhooks, destroy the add-on, clean up the scratch app.

   d. Pipelines tier: list pipelines, create a pipeline, attach an app, list couplings, destroy the coupling, destroy the pipeline.

10. Update notes/divergences.md with any new TOOLS.md vs. actual API divergences.

11. Update TOOLS.md to mark Phase 3 tools (✅ next to each implemented tool's row) and document confirm values for destructive ones.

12. Verify locally:
    pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r format:check && pnpm -r test
    pnpm -r test:integration  # with HEROKUMCP_TEST_TOKEN exported

============================================================
THINGS TO ASK RATHER THAN GUESS
============================================================

- If TOOLS.md is missing a Heroku endpoint that you discover during implementation, ask whether to add it or skip it.
- The credit_pool_info endpoint may or may not be in the enterprise account API depending on the account. Surface what you find.
- For addon_actions_run, the actions are per-service and not all add-on services expose them. Document in the tool description that this only works for services that publish actions.
- If a probe response has an unexpected shape (e.g. /enterprise-accounts returns 422 instead of empty array for accounts the user can't see), surface it.

============================================================
THINGS TO JUST DO
============================================================

- Match the patterns from Phases 1, 2a, 2b
- TSDoc on every exported symbol
- Maintain the existing CI workflow shape
- Don't touch the Phase 4+ scope: HTTP transport, OAuth, Postgres token store, web UI, partner package, deploy repos. All deferred.
- Don't introduce new safety primitives. Use registerWriteTool + the canonical-name pattern as established.

============================================================
ACCEPTANCE CRITERIA FOR PHASE 3
============================================================

Locally:
- pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r format:check && pnpm -r test all green
- pnpm -r test:integration green with HEROKUMCP_TEST_TOKEN set, including all four new tier lifecycle tests

End-to-end with Claude Desktop (do not run — surfaces the requirement for the human reviewer):

The following sequence should work when run by a human against a fresh Claude Desktop session:

  Enterprise tier:
  1. "List the enterprise accounts I have access to." → enterprise_accounts_list
  2. "Show me last month's usage for heroku-demo." → enterprise_account_monthly_usage
  3. "List the members of heroku-demo." → enterprise_account_members_list

  Spaces tier (read-only, against existing herokumx spaces):
  4. "List my private spaces." → spaces_list
  5. "Show me the NAT info for [any existing space]." → spaces_nat_info

  Add-ons tier:
  6. "Show me all my add-ons." → addons_list (paginated)
  7. "Find the add-on named [some addon name]." → addons_resolve
  8. "Provision a Heroku Scheduler add-on on app [test app]." → addons_create
  9. "Show me a dry run of destroying that add-on." → addons_destroy dry_run with pre-fetched state
  10. "Destroy it." → verbal confirm → execute

  Pipelines tier:
  11. "List my pipelines." → pipelines_list
  12. "Show me the apps in pipeline [pipeline name]." → pipeline_couplings_list
  13. "Show me a dry run of promoting [staging app] to production." → pipelines_promote dry_run (no confirm required per Decision 2)

When Phase 3 is complete, STOP and report back with:
  - Final tool count (target ~88 new, total ~240)
  - Capability tiers detected for the test token
  - Confirmation that all four new probes light up
  - Pagination wired on every list endpoint in the new tiers
  - Any divergences added to notes/divergences.md
  - Confirmation that registerWriteTool, canonical-name confirm, and dry_run pre-fetch are reused without modification
  - Whether the spaces creation integration test path was exercised (HEROKUMCP_TEST_SPACE_CREATE env var) or skipped

Do not start Phase 4. We will review and plan it deliberately — Phase 4 is the architecturally largest phase in the project (HTTP transport, OAuth, Postgres token store, web sign-in UI).

Begin.
```

---

## What to expect

Phase 3 is the largest single phase by tool count (~88 new tools across four tiers) but conceptually simpler than 2b. The safety primitives are settled, the canonical-name pattern is established, pagination is wired. Most of the work is volume.

Expect 90-120 minutes of agent time. Could be longer if there are surprises in the API surface that need divergence-log entries.

## Smoke tests when Claude Code finishes

Same as before:

```bash
pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r format:check && pnpm -r test
pnpm -r test:integration
```

Then Claude Desktop:

1. Restart Claude Desktop (Cmd+Q, reopen)
2. New conversation
3. Walk through the 13-step acceptance test from the prompt's "End-to-end with Claude Desktop" section
4. Pay particular attention to:
   - Whether spaces_create properly rejects Shield without log_drain_url at the schema level (the only Phase 3 schema special case)
   - Whether the new probes correctly distinguish tier availability (e.g. you have enterprise access, addons, pipelines, spaces — all four should light up)
   - Whether addons_resolve works as a search-by-name without specifying the app

## After Phase 3

Same rhythm:
1. Verify all checks green
2. Commit with changeset (minor on both packages — new exports in core if any, definitely on platform)
3. Tag `platform-v0.4.0`
4. Push, watch CI
5. Come back here for Phase 4 planning

Phase 4 is where the project gets architecturally interesting. HTTP transport, real OAuth flow, encrypted Postgres-backed token storage, a sign-in web UI, an admin CLI. It's the security-sensitive phase and deserves its own dedicated planning conversation.
