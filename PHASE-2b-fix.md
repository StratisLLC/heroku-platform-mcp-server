# Phase 2b Fix — Confirm pattern uses canonical name from prefetch

> Drop into the repo at `PHASE-2b-fix.md`. Open a **fresh** Claude Code session and paste the prompt block. Do not continue any previous session.

## Why this fix is needed

The Phase 2b Claude Desktop acceptance test exposed a real bug in the confirm pattern. Live transcript:

```
Turn 8 (delete app): user said "delete it"
  Claude → apps_delete(app: "2925e383-d2f8-...", dry_run: true)
            ← preview successful

  Claude → apps_delete(app: "2925e383-...", confirm: "herokumcp-phase2b-claude-test")
            ← REJECTED. expected: "2925e383-..."

  Claude → apps_delete(app: "2925e383-...", confirm: "2925e383-...")
            ← succeeded
```

The confirm guard demanded the UUID because `expectedFrom: (args) => args.app` returns whatever the model passed as input. When Claude resolved the app to its UUID internally and passed the UUID, the guard then demanded the UUID as confirm — but the user typed the human-readable app name in conversation.

This defeats the purpose of confirm. The pattern is supposed to capture "the user explicitly typed this canonical name." If the model can supply the input arg AND the matching confirm value, the user has no real role in the confirmation.

## The fix: confirm matches the resource's canonical name, not the input arg

For every destructive tool that has a `preFetch`, the expected confirm value is extracted from the prefetched response's canonical identifier field, not from `args`.

For destructive tools without a `preFetch` (rare in this codebase), behavior is unchanged: fall back to `args`.

This means: regardless of whether Claude passes the UUID or the name as input, the confirm value is always the human-readable name from Heroku's response. The user typed that name in conversation. Confirmation captures real user intent.

## Prerequisites

```bash
cd /Users/maxpro/Desktop/Github/herokumcp
git status                           # working tree should be clean
git log --oneline | head -5
# Should show recent commits ending at tag platform-v0.2.0
# (Phase 2b commits not yet landed)

pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r format:check && pnpm -r test
# All green — 242 core + 144 platform = 386 tests
```

If anything's off, fix before starting.

---

## The prompt to paste into a fresh Claude Code session

```
Phase 2b is functionally complete but the Claude Desktop acceptance test surfaced a real bug in the confirm pattern that affects every destructive tool. We need to fix it before tagging platform-v0.3.0.

Read these first:

  1. PHASE-2b-fix.md (this file's parent doc) — the bug repro and design decision
  2. packages/platform-mcp/src/write-tool.ts — the registerWriteTool helper that currently has the bug
  3. packages/core/src/confirm.ts — the assertConfirm helper
  4. ARCHITECTURE.md §8.3 — the original confirm pattern design

Then implement the fix described below.

============================================================
THE BUG
============================================================

Live transcript from Claude Desktop:

  Step 1: apps_delete(app: "<UUID>", dry_run: true)  →  preview succeeded
  Step 2: apps_delete(app: "<UUID>", confirm: "<app-name>")  →  REJECTED, expected "<UUID>"
  Step 3: apps_delete(app: "<UUID>", confirm: "<UUID>")  →  succeeded

The confirm guard returns the input arg as the expected value. When the model passes a UUID for input, it must then pass the UUID for confirm. The user typed the human-readable name in conversation; the UUID is something the model resolved internally. The user has no real role in confirmation.

============================================================
THE FIX
============================================================

For destructive tools with a preFetch, derive the expected confirm value from the prefetched response's canonical identifier field, NOT from args. Fall back to args only when no preFetch exists.

This means the confirm string is always what the user would naturally type (the app's name, the collaborator's email, the key's fingerprint, etc.) regardless of what the model passed as the resource identifier in input.

============================================================
IMPLEMENTATION
============================================================

STEP 1 — Update the destructive option type in src/write-tool.ts

Currently the destructive config looks roughly like:
  destructive?: { targetKind: string; expectedFrom: (args) => string }

Change to:
  destructive?: {
    targetKind: string;
    /** Extract the canonical name from the prefetched resource. Use this when preFetch is configured. */
    expectedFromResource?: (resource: TResource) => string;
    /** Extract from input args. Used when no preFetch is configured, or as fallback. */
    expectedFromArgs?: (args: TArgs) => string;
  }

At least one of expectedFromResource or expectedFromArgs must be provided. expectedFromResource takes precedence when preFetch runs and succeeds.

STEP 2 — Update the assertConfirm invocation in registerWriteTool

The flow becomes:
  if (destructive) {
    let expected: string;
    if (preFetch ran successfully AND destructive.expectedFromResource) {
      expected = destructive.expectedFromResource(prefetchedResource);
    } else if (destructive.expectedFromArgs) {
      expected = destructive.expectedFromArgs(args);
    } else {
      throw new Error('Destructive tool must declare expectedFromResource or expectedFromArgs');
    }
    assertConfirm({ value: args.confirm, expected, targetKind: destructive.targetKind });
  }

If preFetch fails (the resource doesn't exist), surface the prefetch error normally — assertConfirm doesn't run because we can't determine what's being confirmed.

STEP 3 — Update every destructive tool registration to use expectedFromResource

The destructive tools and their canonical name fields:

Apps tier (Phase 2a):
- apps_delete                     → resource.name
- apps_disable_acm                → resource.name (prefetch /apps/{id})
- dynos_restart                   → resource.name (prefetch /apps/{id}); fallback: args.app
- dynos_restart_all               → resource.name (prefetch /apps/{id}); fallback: args.app
- dynos_stop                      → resource.name (prefetch /apps/{id}/dynos/{id}); the dyno's name (e.g. "web.1")
- releases_rollback               → app's name (prefetch /apps/{id}); fallback: args.app
- builds_delete_cache             → app's name (prefetch /apps/{id}); fallback: args.app
- domains_delete                  → resource.hostname (prefetch /apps/{id}/domains/{id})
- sni_endpoints_delete            → resource.name (prefetch /apps/{id}/sni-endpoints/{id})
- log_drains_delete               → app's name (prefetch /apps/{id}); fallback: args.app
- telemetry_drains_delete         → resource.id (prefetch /telemetry-drains/{id}); no human name, so id is canonical
- app_webhooks_delete             → app's name (prefetch /apps/{id}); fallback: args.app
- collaborators_delete            → resource.user.email (prefetch /apps/{id}/collaborators/{email})
- app_transfers_update            → app's name (prefetch /app-transfers/{id})
- app_transfers_delete            → app's name (prefetch /app-transfers/{id})
- review_apps_delete              → resource.id (prefetch /review-apps/{id}); no human name
- review_apps_config_delete       → pipeline's name (prefetch /pipelines/{id}/review-app-config)

Account tier (Phase 2b):
- keys_delete                     → resource.fingerprint (prefetch /account/keys/{id_or_fingerprint})
- oauth_authorizations_delete     → resource.description if non-empty else resource.id (prefetch /oauth/authorizations/{id})
- oauth_authorizations_regenerate → resource.id (prefetch /oauth/authorizations/{id})

Teams tier (Phase 2b):
- teams_delete                    → resource.name (prefetch /teams/{id})
- team_members_delete             → resource.email (prefetch /teams/{id}/members/{email})
- team_invitations_revoke         → resource.user.email (prefetch via list-and-filter)
- team_apps_transfer              → resource.name (the app name from prefetch /teams/apps/{id})
- team_app_collaborators_delete   → resource.user.email (prefetch /teams/apps/{id}/collaborators/{email})
- allowed_addon_services_delete   → resource.name (prefetch via list-and-filter — the addon-service name)

For tools where prefetch may not always succeed (e.g. team_invitations_revoke uses list-and-filter; the invitation might have been revoked between the dry-run and the real call), also provide an expectedFromArgs fallback so the code path doesn't crash.

STEP 4 — Update unit tests for every destructive tool

For each tool, replace or add tests covering:
  - "rejects when confirm does not match the prefetched resource's canonical name" — model passes UUID as args.app and the app's name as confirm; this should now SUCCEED (it was failing before the fix)
  - "rejects when confirm is the input arg (UUID) instead of the canonical name" — this should now FAIL (it was succeeding before the fix)
  - "rejects when confirm is empty or missing" — unchanged behavior
  - "rejects when confirm has wrong case" — unchanged behavior
  - Where there's no prefetch (rare): "matches args.app" — fallback behavior

For tools with list-and-filter prefetch:
  - "uses canonical name from list filter result when match found"
  - "returns prefetch error when match not found" — unchanged behavior

STEP 5 — Update the integration test

In packages/platform-mcp/test/integration/platform.integration.test.ts:

In the Phase 2a write lifecycle test, after creating the scratch app, do the dry-run and real delete using the UUID as args.app (not the name), and confirm using the app's name. The expected confirm value comes from the prefetched response's name field, regardless of what we passed as input. This demonstrates the fix.

In the Phase 2b teams-tier lifecycle test, same pattern: when deleting the test invitation, pass the team UUID as args.team and the email as args.user; the confirm value should be the user's email from the prefetched response.

STEP 6 — Update notes/divergences.md

Add a new numbered entry:

  Note #32: confirm pattern uses canonical name from prefetched resource, not input arg

  Original Phase 2a / 2b design: confirm matched whatever was passed as args.<id-field>.
  Bug surfaced in Phase 2b Claude Desktop acceptance test: when Claude resolves a resource
  to its UUID internally and passes the UUID as input, the confirm guard then demanded the
  UUID as confirm — but the user typed the human-readable name in conversation. Fix: extract
  the expected confirm value from the prefetched response's canonical identifier field
  (resource.name for apps, resource.email for collaborators, resource.fingerprint for keys,
  resource.hostname for domains, etc.), with fallback to args for tools without a prefetch.
  This means confirm always captures real user intent (the name the user typed) regardless
  of input encoding.

STEP 7 — Update design docs

In PHASE-2a.md (Decision 1 — Confirm pattern Hybrid), append:

  "Note (post-Phase-2b fix): The expected confirm value is extracted from the prefetched
  resource's canonical identifier field, not from the input arg. This ensures confirm
  captures what the user typed in conversation regardless of whether the model passed
  the resource's UUID or human-readable name as input. See notes/divergences.md #32."

In PHASE-2b.md (Decision 3/4 — Confirm targets), prepend a note above the tables:

  "The 'confirm value' column below describes the canonical identifier the user must type.
  Implementation note: this value is extracted from the prefetched resource's response,
  not from input args. See notes/divergences.md #32 and write-tool.ts."

STEP 8 — Verify locally

pnpm -r build
pnpm -r typecheck
pnpm -r lint
pnpm -r format:check
pnpm -r test

Then with HEROKUMCP_TEST_TOKEN exported:

pnpm -r test:integration

All should be green. The integration test now exercises the canonical-name behavior.

============================================================
THINGS TO ASK RATHER THAN GUESS
============================================================

- If a destructive tool's prefetch response doesn't have an obvious canonical name field, surface it before guessing. Examples: review_apps_delete (does the response have a `branch` or `pr_number` field? what's most user-friendly?), telemetry_drains_delete (the only obvious id is the UUID).
- If list-and-filter prefetch needs additional thought (e.g. allowed_addon_services_delete), surface the response shape.

============================================================
THINGS TO JUST DO
============================================================

- Match the existing code style and tsdoc conventions
- Don't introduce new safety primitives; this is a refinement of the existing pattern
- Keep the existing behavior backward-compatible: tools that pass only expectedFromArgs (no preFetch) work unchanged
- Don't reorganize files; this is an in-place edit

============================================================
ACCEPTANCE CRITERIA
============================================================

Locally:
- pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r format:check && pnpm -r test all green
- pnpm -r test:integration green; the integration tests now demonstrate confirm via the prefetched canonical name

The Claude Desktop acceptance test we'll re-run after this fix lands:

  apps_delete with args.app = "<UUID>"
    Step 1: dry_run: true  →  preview succeeds
    Step 2: confirm = "<the-app-name-the-user-typed>"  →  delete succeeds

  Previously this rejected because confirm had to match the UUID. After the fix, confirm matches the app's name from the prefetch.

When this is done, STOP and report back with:
  - Confirmation that all tools' tests now pass with the canonical-name pattern
  - Any tools where the canonical name choice was ambiguous and you made a judgment call
  - Any divergences from this prompt's design

Do not start Phase 3. We re-run the full Claude Desktop walkthrough after this fix.

Begin.
```

---

## What to expect

This is a targeted fix, not new features. Probably 30-45 minutes of agent time. Most of the work is touching every destructive tool's registration to add `expectedFromResource`, plus a handful of new unit tests per tool.

## After the fix lands

Run the smoke tests:

```bash
pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r format:check && pnpm -r test
pnpm -r test:integration
```

Then re-run the Phase 2b Claude Desktop walkthrough — specifically Turn 7 + 8 (apps_delete) which exposed the bug, and Turn 10 (teams_delete) which would have been the same pattern. With the fix in place, both should:

1. Accept the UUID or name as `args.app` (model's choice)
2. Demand the human-readable name as `confirm` (user's choice)
3. Succeed only when those match

If both work, we tag `platform-v0.3.0` with confidence that the confirm pattern actually does what it's supposed to. Then plan Phase 3.

Quick logistics: while the fix is in flight, leave the existing Phase 2b code uncommitted in your working tree. The fix lands on top of it and the whole batch commits together as one logical "Phase 2b" commit at the end.
