# Phase 2a — Handoff Prompt for Claude Code

> Drop into the repo at `PHASE-2a.md`. Open a **fresh** Claude Code session and paste the prompt block. Do not continue the Phase 1 cleanup session.

## What Phase 2a is

The first phase with destructive writes. Adds ~30 write tools to `@heroku-mcp/platform`, all in the apps tier, all guarded by:

- **Confirm pattern** — destructive tools require a `confirm` parameter matching a specific target identifier
- **dry_run pattern** — all mutating tools accept `dry_run: boolean` and return a structured preview without executing

Both patterns require shared helpers in `@heroku-mcp/core`. Those helpers are part of Phase 2a's deliverable.

## Prerequisites

```bash
cd /Users/maxpro/Desktop/Github/herokumcp
git status                # clean working tree
git log --oneline | head -5
# Should show:
# 97b8d9d chore: Phase 1 cleanup ...
# 753c318 ci: build before typecheck ...
# fef3d1e feat: Phase 1 — @heroku-mcp/platform stdio server
# ...
pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r format:check && pnpm -r test
# All green: 227 + 45 tests passing
```

If anything's not clean, fix before starting.

## Make sure your test app exists and is disposable

Phase 2a's acceptance tests include actual destructive operations. You'll need an app you don't mind deleting:

```bash
heroku create herokumcp-phase2a-test --region us
heroku config:set HELLO=world FAREWELL=cruel-world -a herokumcp-phase2a-test
heroku ps:scale web=0 -a herokumcp-phase2a-test
```

If you already have one from earlier phases, that's fine. The test will create and delete a fresh one anyway.

---

## The prompt to paste into a fresh Claude Code session

```
Phase 1 is complete, tagged at platform-v0.1.0, and all CI is green. The cleanup commits have landed. Begin Phase 2a per ARCHITECTURE.md §15 and the decisions captured below.

Read these documents in this order before writing any code:

  1. ARCHITECTURE.md §8 — tool conventions, particularly §8.3 (destructive ops) and §8.5 (response shapes)
  2. TOOLS.md — every tool marked ⚠ or 🧪 in the apps tier is in scope for Phase 2a
  3. NAMING.md — naming conventions (recap: directory herokumcp, env vars HEROKUMCP_*, npm scope @heroku-mcp/* unchanged)
  4. notes/divergences.md — running log of Phase 1 divergences; you'll add to this as Phase 2a uncovers more

Then explore the existing packages/core and packages/platform-mcp. The patterns Phase 1 established (envelope.ts, tool-helpers.ts, context.ts, the tool registration pattern in tools/*.ts) are the patterns Phase 2a extends.

Scope for Phase 2a: APPS-TIER WRITES ONLY. Do NOT add the teams tier (that's Phase 2b). Do NOT touch the account-tier writes (also Phase 2b). Do NOT implement the dyno run command streaming (deferred to Phase 4 when HTTP transport lands).

============================================================
DESIGN DECISIONS — these are authoritative for Phase 2a
============================================================

DECISION 1 — Confirm pattern (Hybrid)
--------------------------------------
Destructive tools require a `confirm: string` parameter. The MCP server does NOT auto-fill it. The pattern in practice:

  Turn 1: User says "delete myapp"
  Turn 2: Model calls apps_delete with app="myapp" but no confirm
          → Tool returns structured confirmation_required error
          → Model surfaces "To confirm, you want me to delete `myapp`. Should I proceed?"
  Turn 3: User says "yes"
  Turn 4: Model calls apps_delete with app="myapp", confirm="myapp"
          → Tool executes

The model should be instructed (via tool description) NEVER to fill confirm from the same user turn that requested the destructive op. The verbal confirmation in chat is the audit trail.

DECISION 2 — Confirmation error shape (Structured)
---------------------------------------------------
When a destructive tool is called without confirm, or with a mismatched value, the response is:

  {
    ok: false,
    error: {
      kind: "confirmation_required",
      message: "This is a destructive operation. To confirm, pass confirm: '<expected>'.",
      expected: "<the value the model should pass>",
      target_kind: "app" | "addon" | "domain" | "collaborator" | "key" | "drain" | "webhook" | "endpoint" | "release" | "review_app" | ...,
      reason: "destructive operation"
    }
  }

The `expected` field is the most destructive-feeling identifier for the operation. See per-tool confirm values below.

DECISION 3 — dry_run response shape (Both structured and human-readable)
------------------------------------------------------------------------
Every mutating tool accepts `dry_run: boolean` (default false). When true:

  {
    ok: true,
    dry_run: true,
    data: {
      request: {
        method: "DELETE" | "PATCH" | "POST" | "PUT",
        url: "https://api.heroku.com/...",
        headers: { ...non-sensitive headers only... },
        body: <object or null>
      },
      description: "Plain-language summary of what would happen. Include impacts where cheap to fetch (see Decision 6)."
    },
    meta: {
      requestId: null,  // no request was issued
      rateLimitRemaining: <current cached value or null>,
      cached: false
    }
  }

DECISION 4 — dry_run skips confirm
-----------------------------------
If `dry_run: true`, the confirm parameter is NOT required. Dry-run is itself the safety mechanism. The natural flow:

  Step 1: model calls apps_delete with dry_run: true → preview shown
  Step 2: model surfaces preview to user, user confirms verbally
  Step 3: model calls apps_delete with confirm matching expected → actual execution

DECISION 5 — dry_run runs validation, not the write
----------------------------------------------------
On dry_run, do all of the following:
- Token validation (the bearer token check happens at request build time)
- Parameter schema validation
- Capability check (tier must be available for the user's token)
- Schema check against Heroku's published JSON schema
- Build the full HTTP request

Then STOP — do not send the request to Heroku.

If any of the above fails, return the error normally (not wrapped in dry_run). This means dry_run can surface auth/permission errors before the user commits.

DECISION 6 — dry_run for delete operations fetches current state
-----------------------------------------------------------------
For DELETE operations only (apps_delete, addons_delete in scope here, collaborators_delete, domains_delete, sni_endpoints_delete, log_drains_delete, telemetry_drains_delete, app_webhooks_delete, app_transfers_delete, review_apps_delete, builds_delete_cache), the dry_run handler should fetch the current state of the resource via the corresponding GET endpoint and include relevant facts in the `description` field.

Examples:
- apps_delete dry_run → GET /apps/{id} first → "Would delete app 'myapp' (owner: alice@example.com, region: us, stack: heroku-24, created 2024-03-15). This is irreversible."
- addons_delete dry_run → GET /apps/{id}/addons/{id} first → "Would destroy add-on 'mycache' (service: heroku-redis, plan: mini, attached to: myapp)."
- collaborators_delete dry_run → GET /apps/{id}/collaborators/{id} first → "Would remove collaborator bob@example.com from app 'myapp' (added 2024-04-01)."

For non-delete writes (updates, scales, restarts, creates), do NOT fetch current state. Just describe what's being requested.

If the pre-fetch fails (404, 403, etc.), surface the error from the pre-fetch rather than the simulated write — the resource may not exist or may not be accessible.

DECISION 7 — dynos_run special handling
----------------------------------------
dynos_run is NOT destructive per se. Do NOT mark it ⚠. Do NOT require confirm.

But include this warning in the tool description, verbatim:

  "Runs an arbitrary command on a one-off dyno with full app credentials. The command has the same access as your app. Review the command carefully before authorizing. This tool returns the dyno metadata only; streaming the command's output is deferred to a future phase."

Phase 2a returns the dyno metadata (id, name, state, command, type) and does not implement the rendezvous streaming protocol. Document this limitation in tool description and TOOLS.md.

============================================================
TOOLS TO IMPLEMENT IN PHASE 2a
============================================================

All in the apps tier. Confirm value shown in parens for destructive tools.

Apps:
- apps_update (PATCH) — dry_run, expected_etag (no confirm)
- apps_delete ⚠ (DELETE) — confirm: <app name>
- apps_enable_acm (POST) — dry_run, no confirm
- apps_disable_acm ⚠ (DELETE) — confirm: <app name>
- apps_refresh_acm (PATCH) — dry_run, no confirm

App Features:
- app_features_update (PATCH) — dry_run, no confirm

Config Vars:
- config_vars_update (PATCH) — dry_run, no confirm (yes really; updates are reversible)

Formation & Dynos:
- formation_scale (PATCH) — dry_run, no confirm (scaling is reversible)
- dynos_run (POST) — dry_run, no confirm, special warning per Decision 7
- dynos_restart ⚠ (DELETE) — confirm: <app name>
- dynos_restart_all ⚠ (DELETE) — confirm: <app name>
- dynos_stop ⚠ (POST .../actions/stop) — confirm: <dyno name>

Releases:
- releases_create (POST) — dry_run, no confirm
- releases_rollback ⚠ (POST) — confirm: <app name> (NOT the version — rollback affects the live app)

Builds:
- builds_create (POST) — dry_run, no confirm
- builds_delete_cache ⚠ (DELETE) — confirm: <app name>
- buildpack_installations_update (PUT) — dry_run, no confirm

Slugs / OCI:
- slugs_create (POST) — dry_run, no confirm
- oci_image_create (POST) — dry_run, no confirm
- source_create (POST) — dry_run, no confirm

Domains & SSL:
- domains_create (POST) — dry_run, no confirm
- domains_update (PATCH) — dry_run, no confirm
- domains_delete ⚠ (DELETE) — confirm: <hostname>
- sni_endpoints_create (POST) — dry_run, no confirm
- sni_endpoints_update (PATCH) — dry_run, no confirm
- sni_endpoints_delete ⚠ (DELETE) — confirm: <endpoint name>

Logs:
- log_sessions_create (POST) — dry_run, no confirm (creates ephemeral log URL)
- log_drains_create (POST) — dry_run, no confirm
- log_drains_delete ⚠ (DELETE) — confirm: <app name>
- telemetry_drains_create (POST) — dry_run, no confirm
- telemetry_drains_update (PATCH) — dry_run, no confirm
- telemetry_drains_delete ⚠ (DELETE) — confirm: <drain id>

Webhooks:
- app_webhooks_create (POST) — dry_run, no confirm
- app_webhooks_update (PATCH) — dry_run, no confirm
- app_webhooks_delete ⚠ (DELETE) — confirm: <app name>

Collaborators & Transfers:
- collaborators_create (POST) — dry_run, no confirm
- collaborators_delete ⚠ (DELETE) — confirm: <email>
- app_transfers_create (POST) — dry_run, no confirm
- app_transfers_update ⚠ (PATCH) — confirm: <app name> (this accepts/declines a transfer)
- app_transfers_delete ⚠ (DELETE) — confirm: <app name>

Review Apps:
- review_apps_create (POST) — dry_run, no confirm
- review_apps_delete ⚠ (DELETE) — confirm: <review app id>
- review_apps_config_create (POST) — dry_run, no confirm
- review_apps_config_update (PATCH) — dry_run, no confirm
- review_apps_config_delete ⚠ (DELETE) — confirm: <pipeline name>
- app_setups_create (POST) — dry_run, no confirm

Approximately 38 tools total. The exact count after implementation gets documented in the divergence log alongside any TOOLS.md adjustments.

============================================================
IMPLEMENTATION SEQUENCE
============================================================

Do this in order. Each step should be tested before moving to the next.

1. Add confirm helper to @heroku-mcp/core:
   - New file: packages/core/src/confirm.ts
   - Exports: ConfirmationRequiredError (extends a base error), assertConfirm(params: { value: string | undefined, expected: string, targetKind: string }), formatConfirmationError(...)
   - Unit tests covering: missing confirm, mismatched confirm, correct confirm, edge cases (whitespace, case sensitivity — confirm is case-SENSITIVE for safety)

2. Add dry_run helper to @heroku-mcp/core:
   - New file: packages/core/src/dry-run.ts
   - Exports: DryRunResult type, buildDryRunResponse(request, description) helper, optional fetchCurrentStateFor helper for the delete-specific case
   - The helper builds a sanitized request object (strips Authorization header from the headers in the response — leak prevention)
   - Unit tests covering: response shape, header sanitization, with and without description

3. Update packages/core/src/index.ts to export the new helpers. Bump @heroku-mcp/core's internal version line if you track one (otherwise leave for changeset).

4. Add a changeset for @heroku-mcp/core: MINOR bump (these are new exports, additive).

5. Build core first, then move to platform-mcp:
   pnpm --filter @heroku-mcp/core build
   pnpm --filter @heroku-mcp/core test

6. In packages/platform-mcp:
   a. Update src/tool-helpers.ts to add a registerWriteTool helper that wraps registerTool with:
      - Automatic dry_run parameter on the schema
      - Automatic confirm parameter on the schema (only when the tool declares itself destructive)
      - Pre-execution: if dry_run, build request, optionally pre-fetch (for deletes), return DryRunResult
      - Pre-execution: if destructive and not dry_run, call assertConfirm with the per-tool expected value
      - Then call the original handler
   b. Each write tool registration declares { destructive: true, confirmTarget: (params) => params.app } (or similar) so the helper can compute the expected value from the call params

7. Implement the write tools. Suggested file split (one per natural grouping; mirror Phase 1's organization):
   - packages/platform-mcp/src/tools/apps-writes.ts (apps_update, apps_delete, apps_*_acm)
   - packages/platform-mcp/src/tools/config-writes.ts (config_vars_update, app_features_update)
   - packages/platform-mcp/src/tools/formation-writes.ts (formation_scale, dynos_*)
   - packages/platform-mcp/src/tools/releases-writes.ts (releases_create, releases_rollback, builds_*, slugs_create, oci_image_create, source_create, buildpack_installations_update)
   - packages/platform-mcp/src/tools/domains-writes.ts (domains_*, sni_endpoints_*)
   - packages/platform-mcp/src/tools/logs-writes.ts (log_sessions_create, log_drains_*, telemetry_drains_*)
   - packages/platform-mcp/src/tools/webhooks-writes.ts (app_webhooks_*)
   - packages/platform-mcp/src/tools/collab-writes.ts (collaborators_*, app_transfers_*)
   - packages/platform-mcp/src/tools/review-apps-writes.ts (review_apps_*, app_setups_create)
   Update src/tools/index.ts registerAllTools() to wire them in, gated on the apps tier capability.

8. Each destructive tool gets these unit tests (minimum):
   - "rejects when confirm is missing" → returns confirmation_required error with correct expected value
   - "rejects when confirm is mismatched" → same error, message reflects mismatch
   - "rejects when confirm has wrong case" → case-sensitive check
   - "accepts dry_run: true without confirm" → returns DryRunResult, no HTTP call made
   - "for delete ops: dry_run pre-fetches current state" → check the description field includes current state facts
   - "accepts correct confirm" → calls the API, returns wrapped success
   - "respects dry_run flag even when confirm is correct" → still returns preview, no real call

9. Each non-destructive write tool gets:
   - "accepts dry_run: true" → returns DryRunResult
   - "without dry_run: calls the API" → success path
   - "schema validation on params" → invalid input rejected

10. Integration tests in packages/platform-mcp/test/integration/platform.integration.test.ts. Extend the existing live test to:
    - Create a fresh app named like `herokumcp-phase2a-int-${Date.now()}`
    - Set a config var on it (config_vars_update without dry_run, no confirm needed)
    - Scale formation (formation_scale)
    - Update the app name (apps_update)
    - Call apps_delete with dry_run: true and verify the description mentions the app's owner / region / etc.
    - Call apps_delete with confirm matching the new name → verify deletion
    - All gated on HEROKUMCP_TEST_TOKEN as before; SKIPPED when token absent

11. Update TOOLS.md:
    - For every destructive tool listed above, add a "confirm:" column showing the expected value
    - Add a "Phase 2a notes" section at the top explaining the confirm + dry_run patterns
    - Document the dry_run pre-fetch behavior for deletes

12. Update notes/divergences.md with any new TOOLS.md vs. actual-API divergences uncovered.

13. Verify locally:
    pnpm -r build
    pnpm -r typecheck
    pnpm -r lint
    pnpm -r format:check
    pnpm -r test
    # with HEROKUMCP_TEST_TOKEN exported:
    pnpm -r test:integration

============================================================
THINGS TO ASK RATHER THAN GUESS
============================================================

- Any tool above where the confirm target identifier is ambiguous (the assignment in this prompt is authoritative; if you think it's wrong, surface the concern instead of changing it silently).
- Any case where Heroku's actual API behavior contradicts TOOLS.md (add to notes/divergences.md and ask if it should be fixed in this phase).
- If a Heroku endpoint requires a header or parameter not documented in TOOLS.md (e.g. some endpoints want X-Heroku-Three-Factor-Code) — surface it; we'll decide whether to skip the tool or implement the extra plumbing.
- If implementing pre-fetch for a delete operation requires an unusual API path (e.g. the resource isn't fetchable via simple GET), surface it before implementing.

============================================================
THINGS TO JUST DO
============================================================

- Match the code style of packages/core and packages/platform-mcp (Phase 1's patterns)
- TSDoc on every exported symbol
- Maintain the existing CI workflow shape (the build-before-typecheck order from CI.yml stays)
- Don't touch the teams tier, account writes, or anything outside packages/platform-mcp/src/tools/*-writes.ts and the new core helpers

============================================================
ACCEPTANCE CRITERIA FOR PHASE 2a
============================================================

Locally:
- pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r format:check && pnpm -r test all green
- pnpm -r test:integration green with HEROKUMCP_TEST_TOKEN set

End-to-end with Claude Desktop:
- Restart Claude Desktop with the existing herokumcp-platform-dev config (already pointing at dist/index-stdio.js)
- Ask: "Show me a dry run of deleting my test app `<name>`."
  → Should call apps_delete with dry_run: true, return description including the app's facts
  → Should NOT have deleted anything; verify by `heroku apps:info -a <name>`
- Ask: "OK, delete it."
  → Model should ask for verbal confirmation
- Reply: "yes, delete it"
  → Model should call apps_delete with confirm matching the app name
  → App should actually be deleted; verify by `heroku apps`

When Phase 2a is complete, STOP and report back with:
  - Final tool count and full list
  - Capability tiers detected
  - Any divergences added to notes/divergences.md
  - Whether the Claude Desktop dry_run → confirm → delete flow worked

Do not start Phase 2b. We will review and plan it deliberately.

Begin.
```

---

## What to expect

Phase 2a is bigger than Phase 1 in source files but smaller in conceptual surface — the patterns are established. Expect ~60-90 minutes of agent time.

## Smoke tests when Claude Code finishes

Same shape as Phase 1, plus the destructive flow:

```bash
# Local
pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r format:check && pnpm -r test
export HEROKUMCP_TEST_TOKEN="HRKU-..."
pnpm -r test:integration

# Create a disposable app for the Claude Desktop test
heroku create herokumcp-phase2a-claude-test --region us
heroku config:set HELLO=world -a herokumcp-phase2a-claude-test
heroku ps:scale web=0 -a herokumcp-phase2a-claude-test
```

Then in Claude Desktop (restart it first to pick up the rebuilt binary):

1. "Show me a dry run of deleting herokumcp-phase2a-claude-test."
   → Should preview, NOT delete. Verify with `heroku apps:info -a herokumcp-phase2a-claude-test`.

2. "OK, delete it."
   → Should ask you to confirm verbally.

3. "Yes, delete it."
   → Should actually delete. Verify with `heroku apps | grep claude-test`.

If all three steps work, Phase 2a is genuinely done.

## After Phase 2a

Same ritual: review divergences, commit, changeset (`@heroku-mcp/core` minor for the helpers, `@heroku-mcp/platform` minor for the writes), tag `platform-v0.2.0`, push, watch CI. Then come back here for Phase 2b planning.
