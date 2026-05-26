# Phase 2b — Handoff Prompt for Claude Code

> Drop into the repo at `PHASE-2b.md`. Open a **fresh** Claude Code session and paste the prompt block. Do not continue any previous session.

## What Phase 2b is

The second write phase. Adds:

- **~12 account-tier write tools** (extending the account tier that Phase 1 opened up for reads)
- **A new teams capability tier** with ~30 read + write tools, gated by a new probe

All write tools reuse the `registerWriteTool` helper from Phase 2a — confirm + dry_run patterns already exist. Most of Phase 2b is volume work: applying established patterns to new endpoints.

Two notable tools have caveats:
- `teams_create` and `teams_delete` are implemented but carry deprecation context in their descriptions (Heroku CLI removed the equivalent commands; enterprise-team creation lives at a different endpoint exposed in Phase 3)
- `account_delete` is **not** implemented in Phase 2b (deferred indefinitely; users should delete accounts via the dashboard)

## Prerequisites

```bash
cd /Users/maxpro/Desktop/Github/herokumcp
git status                                  # clean working tree
git log --oneline | head -5
# Should show recent commits ending at platform-v0.2.0 tag

pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r format:check && pnpm -r test
# All green: 342 tests (242 core + 100 platform-mcp)

pnpm -r test:integration
# All green (with HEROKUMCP_TEST_TOKEN exported)
```

If anything's off, fix before starting.

## Test environment setup

This phase requires a Heroku **team** for testing. The team must already exist before Claude Code starts:

```bash
heroku teams | grep herokumcp-phase2b-test
```

Should show `herokumcp-phase2b-test admin`. If not, create it via the Heroku Dashboard under the appropriate enterprise account (the API doesn't allow team creation outside the enterprise endpoint, which is Phase 3 territory).

Also verify your test token can see it:

```bash
curl -s -H "Authorization: Bearer $HEROKUMCP_TEST_TOKEN" -H "Accept: application/vnd.heroku+json; version=3" -H "Range: name ..; max=1000;" https://api.heroku.com/teams | python3 -c "import json, sys; teams = json.load(sys.stdin); [print(t['name']) for t in teams if 'phase2b' in t['name'].lower()]"
```

Should print `herokumcp-phase2b-test`. If not, the test token doesn't have access — fix before continuing.

Create the test app under the team:

```bash
heroku create herokumcp-phase2b-claude-test --team herokumcp-phase2b-test --region us
heroku ps:scale web=0 --app herokumcp-phase2b-claude-test
heroku config:set HELLO=world --app herokumcp-phase2b-claude-test
```

The `ps:scale web=0` will warn about no `web` process type — harmless.

---

## The prompt to paste into a fresh Claude Code session

```
Phase 2a is complete, tagged at platform-v0.2.0, and all CI is green. Begin Phase 2b per ARCHITECTURE.md §15 and the decisions captured below.

Read these documents in this order before writing any code:

  1. ARCHITECTURE.md §5 (capability discovery) and §8 (tool conventions)
  2. TOOLS.md sections for "account" tier (the read tools are in Phase 1; the write tools are in scope for Phase 2b) and "teams" tier (entirely in scope for Phase 2b)
  3. CAPABILITY_PROBES.md — the teams probe (`teams.list`) is in scope
  4. NAMING.md — naming conventions remain (HEROKUMCP_*, @heroku-mcp/* npm scope unchanged)
  5. notes/divergences.md — running log; Phase 2b will add more entries here

Then explore packages/platform-mcp/src/tools/*.ts and packages/platform-mcp/src/write-tool.ts. The `registerWriteTool` helper from Phase 2a IS the pattern for every write tool in Phase 2b. Do not invent a new helper.

============================================================
DESIGN DECISIONS — authoritative for Phase 2b
============================================================

DECISION 1 — `account_delete` is NOT implemented
-------------------------------------------------
Do not include `account_delete` (DELETE /account) in this phase. The endpoint requires the user's password as a header and has dangerous consequences. Users should delete their Heroku account via the Heroku Dashboard. Document the omission in TOOLS.md with a one-line note next to the account tier section: "Account deletion is intentionally not exposed; use the Heroku Dashboard."

DECISION 2 — `teams_create` and `teams_delete` ARE implemented, with deprecation context in their descriptions
---------------------------------------------------------------------------------------------------------------
The Heroku Platform API supports `POST /teams` and `DELETE /teams/{id}`. The Heroku CLI has removed its `teams:create` and `teams:destroy` commands because Heroku now recommends team creation/deletion through enterprise account dashboards. The API endpoints still work and create/destroy non-enterprise "standalone" teams.

Both tools must include the following context in their MCP tool description (verbatim, or close to it — adjust grammar but keep the substance):

For `teams_create`:
  "Creates a non-enterprise team via POST /teams on the Heroku Platform API. **Important context:** the Heroku CLI removed its `teams:create` command because Heroku now recommends creating teams through an Enterprise account dashboard (a separate endpoint at POST /enterprise-accounts/{id}/teams, exposed in a later phase). The API endpoint this tool wraps still works and creates a standalone (non-enterprise) team that has limited functionality compared to enterprise-owned teams. Use this only when you specifically want a standalone team; for enterprise users, use the enterprise team creation tool when it becomes available."

For `teams_delete`:
  "Deletes a non-enterprise team via DELETE /teams/{id}. **Important context:** the Heroku CLI removed its `teams:destroy` command for the same reasons as `teams_create`. The API endpoint works and will destroy the team; apps continue to exist under the user who created them but lose team membership. Enterprise-owned teams must be deleted through the enterprise account, not this tool. Requires confirm matching the team name."

The "confirm value" column below describes the canonical identifier the user must type. Implementation note: this value is extracted from the prefetched resource's response, not from input args. See notes/divergences.md #33 and packages/platform-mcp/src/write-tool.ts.

DECISION 3 — Confirm targets for destructive teams-tier tools
--------------------------------------------------------------
| Tool                                | confirm value     |
|-------------------------------------|-------------------|
| teams_delete                        | <team name>       |
| team_members_delete                 | <member email>    |
| team_invitations_revoke             | <invited email>   |
| team_apps_transfer                  | <app name>        |
| team_app_collaborators_delete       | <email>           |
| allowed_addon_services_delete       | <service name>    |

DECISION 4 — Confirm targets for destructive account-tier tools (extending Phase 2a's pattern to the account tier)
------------------------------------------------------------------------------------------------------------------
| Tool                                | confirm value          |
|-------------------------------------|------------------------|
| keys_delete                         | <key fingerprint>      |
| oauth_authorizations_delete         | <id or description>    |
| oauth_authorizations_regenerate     | <authorization id>     |

DECISION 5 — dry_run pre-fetch for delete operations
-----------------------------------------------------
All destructive teams-tier ops follow the Phase 2a pattern: dry_run pre-fetches the resource's current state and includes it in the description field. For resources without an individual GET endpoint (specifically `team_invitations_revoke` and `allowed_addon_services_delete`), pre-fetch via list-and-filter:
  - team_invitations_revoke dry_run: GET /teams/{id}/invitations, find the matching one, surface its role + sent-at + sender
  - allowed_addon_services_delete dry_run: GET /teams/{id}/allowed-addon-services, find the matching one, surface its name + added-by

Same for account-tier deletes (keys_delete, oauth_authorizations_delete):
  - keys_delete dry_run: GET /account/keys/{id_or_fingerprint}, surface comment + created-at
  - oauth_authorizations_delete dry_run: GET /oauth/authorizations/{id}, surface description + scope + created-at

DECISION 6 — `keys_create` IS implemented
------------------------------------------
Yes, implement `keys_create` (POST /account/keys). Heroku has been gradually deprecating SSH-key-based deploys but the endpoint works and some users still need it. The read-side `keys_list` was exposed in Phase 1, so excluding the write side would be asymmetric. No special deprecation note required — just standard tool description.

DECISION 7 — Teams probe is new
--------------------------------
A new probe lights up the teams tier. It's already described in CAPABILITY_PROBES.md (probe id `teams.list`). The prober already exists; verify the teams.list probe is wired up and that capabilities.ts gates teams-tier tools on it. If the probe was not wired up in Phase 1, wire it now (it was originally specified for Phase 2, alongside teams-tier reads — which Phase 1 didn't implement, so the probe may have been added without a teams tier to gate).

When the probe returns 0 teams (the response is an empty array `[]`), the teams tier should still light up — the user has the capability, they just have no teams. Tools that operate on individual teams (`teams_info`, `team_members_list`, etc.) will return 404 from Heroku if called with a nonexistent team name, which the existing error handling surfaces correctly. Don't suppress the teams tier just because the probe returned an empty list.

DECISION 8 — Pagination matters here
-------------------------------------
The `/teams` endpoint default page size is 25. Several Heroku tokens (including the test token) are members of more than 25 teams. The teams_list tool MUST use the @heroku-mcp/core pagination helper so users can fetch beyond the default. Same applies to other list endpoints in this tier (team_members_list, team_invitations_list, etc.).

============================================================
TOOLS TO IMPLEMENT IN PHASE 2b
============================================================

ACCOUNT-TIER WRITES (12 tools):
- account_update (PATCH /account) — dry_run, no confirm
- account_features_update (PATCH /account/features/{id_or_name}) — dry_run, no confirm
- account_sms_number_recover (POST /account/sms-number/actions/recover) — dry_run, no confirm
- keys_create (POST /account/keys) — dry_run, no confirm
- keys_delete ⚠ (DELETE /account/keys/{id_or_fingerprint}) — confirm: <fingerprint>
- oauth_authorizations_create (POST /oauth/authorizations) — dry_run, no confirm
- oauth_authorizations_delete ⚠ (DELETE /oauth/authorizations/{id}) — confirm: <id or description>
- oauth_authorizations_regenerate ⚠ (POST /oauth/authorizations/{id}/actions/regenerate-tokens) — confirm: <id>
- invoice_address_update (PUT /account/invoice-address) — dry_run, no confirm
- credits_create (POST /account/credits) — dry_run, no confirm
- user_preferences_update (PATCH /users/~/preferences) — dry_run, no confirm

DO NOT IMPLEMENT: account_delete, oauth_tokens_create (the latter is a token issuance endpoint primarily used in OAuth flows, not Phase 2b scope).

TEAMS-TIER (full read + write set, ~32 tools):

Reads (these may exist as stubs in Phase 1 — extend or implement now if missing):
- teams_list (paginated)
- teams_info
- team_members_list (paginated)
- team_apps_list (paginated)
- team_apps_info
- team_app_collaborators_list (paginated)
- team_app_permissions_list
- team_invitations_list (paginated)
- team_invoices_list (paginated)
- team_invoices_info
- team_daily_usage
- team_monthly_usage
- team_features_list (paginated)
- team_features_info
- team_addons_list (paginated)
- team_preferences_get
- team_spaces_list (paginated)
- team_delinquency_info
- team_members_apps_list (paginated)
- allowed_addon_services_list (paginated)

Writes:
- teams_create (POST /teams) — dry_run, no confirm. SPECIAL: include deprecation context in description (see Decision 2).
- teams_update (PATCH /teams/{id_or_name}) — dry_run, no confirm
- teams_delete ⚠ (DELETE /teams/{id_or_name}) — confirm: <team name>. SPECIAL: include deprecation context in description.
- team_members_create_or_update (PUT /teams/{id_or_name}/members) — dry_run, no confirm
- team_members_delete ⚠ (DELETE /teams/{id_or_name}/members/{email_or_id}) — confirm: <member email>
- team_apps_create (POST /teams/apps) — dry_run, no confirm
- team_apps_update_locked (PATCH /teams/apps/{id_or_name}) — dry_run, no confirm
- team_apps_transfer ⚠ (PATCH /teams/apps/{id_or_name} with owner field) — confirm: <app name>. Implement as a separate tool from team_apps_update_locked since the semantics differ.
- team_app_collaborators_create (POST /teams/apps/{id_or_name}/collaborators) — dry_run, no confirm
- team_app_collaborators_update (PATCH /teams/apps/{id_or_name}/collaborators/{email}) — dry_run, no confirm
- team_app_collaborators_delete ⚠ (DELETE /teams/apps/{id_or_name}/collaborators/{email}) — confirm: <email>
- team_invitations_create (PUT /teams/{id_or_name}/invitations) — dry_run, no confirm
- team_invitations_accept (POST /teams/invitations/{token}/accept) — dry_run, no confirm
- team_invitations_revoke ⚠ (DELETE /teams/{id_or_name}/invitations/{user}) — confirm: <invited email>
- team_features_update (PATCH /teams/{id_or_name}/features/{id_or_name}) — dry_run, no confirm
- team_preferences_update (PATCH /teams/{id_or_name}/preferences) — dry_run, no confirm
- allowed_addon_services_create (POST /teams/{id_or_name}/allowed-addon-services) — dry_run, no confirm
- allowed_addon_services_delete ⚠ (DELETE /teams/{id_or_name}/allowed-addon-services/{id_or_name}) — confirm: <service name>

Approximate Phase 2b total: ~12 account writes + ~32 teams tier (mixing existing reads if any + new writes) = ~44 new tools, bringing the platform-mcp total to roughly 147.

NOTE: team_apps_delete is NOT a separate tool. Team-owned apps are deleted via the existing apps_delete tool from Phase 2a (it works against the same /apps/{id_or_name} endpoint regardless of team ownership). Do not duplicate.

============================================================
IMPLEMENTATION SEQUENCE
============================================================

1. Verify or wire up the teams probe:
   - Check packages/core/src/probes.ts for the `teams.list` probe definition
   - Check packages/platform-mcp/src/capabilities.ts for the teams tier gating logic
   - If teams tier is referenced but the probe doesn't actually run, fix it
   - If the probe runs but no teams-tier tools register against it, that's expected (Phase 1 didn't have teams tools) — Phase 2b will populate that gap
   - Add a test that confirms: when teams.list returns 200 with an empty array, teams tier is available

2. Create the teams tier read files first (mirrors Phase 1's apps tier organization):
   - packages/platform-mcp/src/tools/teams.ts (teams_list/info/members/etc — all the read-only ones)
   - Implement and test all teams-tier reads from the list above
   - All list operations MUST use the pagination helper from @heroku-mcp/core

3. Create the teams tier write files (mirrors Phase 2a's split-by-group):
   - packages/platform-mcp/src/tools/teams-writes.ts (teams CRUD, members, apps, invitations, features, preferences, allowed-addon-services, app-collaborators)
     - Single file is fine for v1; split if it exceeds ~600 lines
   - All write tools use registerWriteTool

4. Create the account writes file:
   - packages/platform-mcp/src/tools/account-writes.ts
   - All 12 account-tier writes

5. Wire all new tool registrations into packages/platform-mcp/src/tools/index.ts, gated by the appropriate tier

6. For every destructive tool, ensure unit tests cover:
   - Missing confirm → confirmation_required error
   - Mismatched confirm → confirmation_required error
   - dry_run: true without confirm → preview returned
   - For deletes with no individual GET (team_invitations_revoke, allowed_addon_services_delete): dry_run pre-fetches via list-and-filter
   - Correct confirm → success path
   - Schema validation rejection on bad params

7. Update notes/divergences.md as you discover divergences from TOOLS.md

8. Update TOOLS.md:
   - Mark Phase 2b account writes with their confirm columns
   - Mark Phase 2b teams writes with their confirm columns
   - Add the one-line "Account deletion is intentionally not exposed" note
   - Add the deprecation context notes for teams_create / teams_delete (or reference their tool descriptions)

9. Extend packages/platform-mcp/test/integration/platform.integration.test.ts with a teams-tier lifecycle test:
   - List teams (paginated) — verify herokumcp-phase2b-test appears
   - List apps in herokumcp-phase2b-test — verify herokumcp-phase2b-claude-test appears
   - Set a config var on herokumcp-phase2b-claude-test (config_vars_update from Phase 2a, on a team-owned app)
   - Invite test-fake@example.com to herokumcp-phase2b-test (team_invitations_create)
   - Dry-run revoke the invitation — verify pre-fetched state appears in description
   - Real revoke (with confirm)
   - Dry-run delete herokumcp-phase2b-claude-test
   - Real delete (with confirm)
   - Create a standalone team (teams_create) with a unique name like herokumcp-phase2b-ephemeral-${Date.now()}
   - Dry-run delete that team — verify pre-fetched state appears in description
   - Real delete that team (with confirm)

   Skip when HEROKUMCP_TEST_TOKEN absent (existing pattern).

10. Add an account-tier write integration test (also in platform.integration.test.ts):
    - Get current account state via account_info (Phase 1)
    - dry-run account_update with a fake name change — verify preview shows the change
    - Do NOT actually update the account; the dry-run is sufficient

11. Verify locally:
    pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r format:check && pnpm -r test
    pnpm -r test:integration  # with HEROKUMCP_TEST_TOKEN exported

============================================================
THINGS TO ASK RATHER THAN GUESS
============================================================

- If the teams probe in CAPABILITY_PROBES.md doesn't match what's actually wired up in packages/core/src/probes.ts, surface the discrepancy
- If a teams-tier endpoint requires a header or parameter not documented in TOOLS.md, ask
- If teams_create requires fields beyond `name` (e.g., billing details for non-enterprise teams), surface what Heroku actually demands rather than guessing
- If team_apps_transfer turns out to need both old_owner AND new_owner in the request body, ask whether to surface both as params or auto-derive one

============================================================
THINGS TO JUST DO
============================================================

- Match the patterns from Phase 1 and Phase 2a
- TSDoc on every exported symbol
- Maintain the existing CI workflow shape (already builds before typecheck)
- Don't touch enterprise, spaces, addons-consumer, pipelines, or any other tier — those are Phase 3+
- Don't add new safety primitives — confirm + dry_run + registerWriteTool already exist

============================================================
ACCEPTANCE CRITERIA FOR PHASE 2b
============================================================

Locally:
- pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r format:check && pnpm -r test all green
- pnpm -r test:integration green with HEROKUMCP_TEST_TOKEN set, including the new teams-tier and account-tier lifecycle tests

End-to-end with Claude Desktop (do not run — surfaces only the requirement for the human reviewer to verify):
The following sequence should work when run by a human against a fresh Claude Desktop session:

  1. "List the teams I'm a member of." → teams_list returns paginated results including herokumcp-phase2b-test
  2. "Show me the apps in herokumcp-phase2b-test." → team_apps_list
  3. "Set a new config var TEST_VAR=phase2b on herokumcp-phase2b-claude-test in team herokumcp-phase2b-test." → config_vars_update on team-owned app
  4. "Invite test-fake@example.com as a member of herokumcp-phase2b-test (member role)." → team_invitations_create
  5. "Show me a dry run of revoking that invitation." → team_invitations_revoke with dry_run, including pre-fetched invitation state
  6. "Revoke it." → verbal confirm, then execute
  7. "Show me a dry run of deleting herokumcp-phase2b-claude-test from team herokumcp-phase2b-test." → apps_delete dry_run on team-owned app
  8. "Delete it." → verbal confirm, then execute
  9. "Create a new standalone team called herokumcp-phase2b-ephemeral." → teams_create; model should mention this is a standalone team, not enterprise
  10. "Delete that team." → teams_delete dry_run → verbal confirm → execute

When Phase 2b is complete, STOP and report back with:
- Final tool count and full list of newly added tools
- Capability tiers detected (which probes lit up for the test token)
- Any divergences added to notes/divergences.md
- Confirmation that all the patterns from Phase 2a (registerWriteTool, dry_run pre-fetch, confirm error shape) are reused without modification
- Confirmation that pagination is wired up on all list endpoints in the teams tier

Do not start Phase 3. We will review and plan it deliberately.

Begin.
```

---

## What to expect

Phase 2b is larger than Phase 2a in tool count (~44 new tools vs 47) but conceptually simpler. The safety primitives are built; this is mostly applying them to a new endpoint family. Expect 60-90 minutes of agent time.

## Smoke tests when Claude Code finishes

Local:
```bash
pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r format:check && pnpm -r test
pnpm -r test:integration
```

Then Claude Desktop:
1. Restart Claude Desktop (Cmd+Q, reopen)
2. New conversation
3. Walk through the 10 acceptance test steps from the prompt
4. Pay particular attention to:
   - Whether teams_list paginates correctly (the test token has 25+ teams)
   - Whether the teams_create response includes the deprecation context in the dry-run description
   - Whether teams_delete asks for the team name as verbal confirm before passing it to the tool

## After Phase 2b

Same rhythm:
1. Verify all checks green
2. Commit + changeset (likely minor on platform-mcp, maybe minor on core if the prober wiring changed)
3. Tag `platform-v0.3.0`
4. Push, watch CI
5. Come back here for Phase 3 planning

Phase 3 adds Enterprise, Spaces, Add-ons consumer, Pipelines tiers — the rest of the customer-side surface. After Phase 3, Phase 4 introduces the HTTP transport and OAuth, which unlocks the Heroku Button deployment path.
