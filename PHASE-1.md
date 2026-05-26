# Phase 1 — Handoff Prompt for Claude Code

> Paste the content between the `---` lines below into a **fresh** Claude Code session opened against the `herokumcp` workspace. Do not continue the Phase 0 session.

## Prerequisites checklist

Before pasting the prompt, verify locally:

```bash
# All green:
pnpm -r typecheck && pnpm -r lint && pnpm -r format:check && pnpm -r test && pnpm -r build

# Test token exported (will be needed for the smoke-test step at end of Phase 1):
echo "${HEROKUMCP_TEST_TOKEN:-NOT SET}" | head -c 8

# Test account has surface for the prober to find:
heroku apps        # at least one app
heroku teams       # team membership helpful but not required for Phase 1
```

If any of the above is wrong, fix before starting the new session.

## Pre-stage Claude Desktop config

Add the following to `~/Library/Application Support/Claude/claude_desktop_config.json` (create the file if it doesn't exist; merge into existing `mcpServers` if it does). Phase 1's acceptance test is "Claude Desktop can list apps via this MCP."

```json
{
  "mcpServers": {
    "herokumcp-platform-dev": {
      "command": "node",
      "args": [
        "/Users/maxpro/Desktop/Github/HerokuMCP/herokumcp/packages/platform-mcp/dist/index-stdio.js"
      ],
      "env": {
        "HEROKUMCP_TOKEN": "HRKU-<your-test-token>"
      }
    }
  }
}
```

Restart Claude Desktop after saving. The MCP entry will show as failed until the binary exists (i.e. until Phase 1 builds it), which is fine.

---

## The prompt to paste

```
Phase 0 is complete and tagged at core-v0.1.0. packages/core is built, tested (227 unit tests + a live integration test against api.heroku.com), linted, formatted, and pushed to github.com/baliles/herokumcp with CI passing on Node 20 and 22.

Begin Phase 1 per ARCHITECTURE.md §15: implement packages/platform-mcp end-to-end for the account and apps tiers, read-only, stdio transport only.

Read these documents in this order before writing any code:

  1. ARCHITECTURE.md — refresh on overall design
  2. NAMING.md — naming conventions (directory: herokumcp; env vars: HEROKUMCP_*; npm scope: @heroku-mcp/* unchanged)
  3. CAPABILITY_PROBES.md — the probe matrix you'll be wiring up
  4. TOOLS.md — specifically the diagnostic tools, account tier, and apps tier read-only entries

Then explore the existing packages/core to understand what's available — pay attention to the exported surface of @heroku-mcp/core, especially the HTTP client, prober, error types, audit log, and the probe matrix in probes.ts. Phase 1 is the first consumer of these interfaces; if anything in the core feels wrong as you build against it, surface the issue before working around it.

Scope for Phase 1, in order:

1. Scaffold packages/platform-mcp:
   - tsconfig extending tsconfig.base.json
   - tsup config matching packages/core's pattern
   - vitest config matching packages/core's pattern (exclude *.integration.test.ts from default runs)
   - package.json with scripts: build, typecheck, lint, format, format:check, test, test:integration
   - Add @heroku-mcp/core as a workspace dependency
   - Add @modelcontextprotocol/sdk as a regular dependency (latest stable, currently ^1.x)
   - Update root pnpm-workspace.yaml if needed

2. Stub the stdio entrypoint at src/index-stdio.ts:
   - Read HEROKUMCP_TOKEN from env, or accept --token CLI arg
   - If no token: fail with a clear, redacted error message and exit code 2
   - Initialize the MCP server with stdio transport per the SDK docs
   - Handle initialize, tools/list, tools/call
   - Start with empty tool list — verify Claude Desktop can connect and see zero tools

3. Wire in capability probing:
   - At startup, after validating the token, run the prober from @heroku-mcp/core
   - Persist the result to $HEROKUMCP_HOME/capabilities/<token-fingerprint>.json per ARCHITECTURE.md §5.3
   - Use the cached result if present and within TTL (1h default)
   - Expose refresh_capabilities tool that forces re-probing and emits notifications/tools/list_changed

4. Implement diagnostic tools (always exposed regardless of probe result):
   - whoami (wraps GET /account)
   - refresh_capabilities (above)
   - rate_limit_status (wraps GET /account/rate-limits)
   - audit_tail (reads recent audit log entries from local store)
   - schema_info (returns cached schema metadata: version, last fetched)

5. Implement account-tier read-only tools (exposed when account tier probe succeeded):
   - account_info (GET /account)
   - account_delinquency_info (GET /account/delinquency)
   - account_features_list (GET /account/features) [paginated]
   - account_sms_number_get (GET /account/sms-number)
   - keys_list (GET /account/keys) [paginated]
   - keys_info (GET /account/keys/{id_or_fingerprint})
   - oauth_authorizations_list (GET /oauth/authorizations) [paginated]
   - oauth_authorizations_info (GET /oauth/authorizations/{id})
   - oauth_clients_list (GET /oauth/clients) [paginated]
   - oauth_clients_info (GET /oauth/clients/{id})
   - invoices_list (GET /account/invoices) [paginated]
   - invoices_info (GET /account/invoices/{number})
   - invoice_address_info (GET /account/invoice-address)
   - credits_list (GET /account/credits) [paginated]
   - user_preferences_get (GET /users/~/preferences)

6. Implement apps-tier read-only tools (exposed when apps tier probe succeeded):
   - apps_list, apps_list_owned, apps_info, apps_filter
   - app_features_list, app_features_info
   - config_vars_get, config_vars_get_release
   - formation_list, formation_info
   - dyno_sizes_list
   - dynos_list, dynos_info
   - releases_list, releases_info
   - builds_list, builds_info
   - buildpack_installations_list
   - slugs_info
   - domains_list, domains_info
   - sni_endpoints_list, sni_endpoints_info
   - log_drains_list, log_drains_info
   - telemetry_drains_list
   - app_webhooks_list, app_webhooks_info
   - app_webhook_deliveries_list, app_webhook_deliveries_info
   - app_webhook_events_list, app_webhook_events_info
   - collaborators_list, collaborators_info
   - app_transfers_list, app_transfers_info

Do NOT implement: writes (POST/PATCH/PUT/DELETE), confirm guards, dry_run handling. All write tools land in Phase 2.

For each tool:
  - JSON Schema input validation per @modelcontextprotocol/sdk patterns
  - Pagination params (page_size, cursor) on list tools, wired to core's pagination helper
  - Response shape per ARCHITECTURE.md §8.5 (ok/data/meta envelope on success, ok/error on failure)
  - Vitest unit test against a mocked core client
  - Integration test in test/integration/ gated on HEROKUMCP_TEST_TOKEN — at minimum: apps_list, apps_info, config_vars_get, account_info, whoami

Things to ASK rather than guess:
  - Anything not in the design docs
  - Cases where Heroku's actual API behavior contradicts TOOLS.md — keep a divergence log at notes/divergences.md so we can update TOOLS.md later
  - Whether to use the SDK's high-level registerTool helpers vs the lower-level Server class — your call, but document the choice in a code comment near the entry point

Things you should JUST DO:
  - Match the code style of packages/core
  - Extend the existing CI workflow to typecheck/lint/format-check/test packages/platform-mcp (the workflow already runs `pnpm -r` for these, so no edits needed — just verify the new package's scripts run)
  - TSDoc on every exported symbol
  - Keep the binary executable: package.json "bin" field pointing to dist/index-stdio.js with a shebang line in the source

Acceptance criteria for Phase 1:

  Locally:
    - pnpm -r typecheck && pnpm -r lint && pnpm -r format:check && pnpm -r test && pnpm -r build — all green
    - pnpm -r test:integration with HEROKUMCP_TEST_TOKEN set — all green
    - Both packages/core and packages/platform-mcp are exercised in tests

  End-to-end with Claude Desktop:
    - Restart Claude Desktop with the herokumcp-platform-dev MCP config pointing at the built dist/index-stdio.js
    - Asking Claude Desktop "what apps do I have on Heroku?" returns the actual list of apps from my test account
    - Asking "tell me about my apps with a config var named DATABASE_URL" works — i.e. it can chain apps_list and config_vars_get

  Capability gating:
    - On a token with team access, teams tier tools should NOT appear (Phase 1 doesn't implement them)
    - On a token without enterprise access, enterprise tier tools NOT appearing is expected (also not in Phase 1 scope)
    - The probe result file should exist at $HEROKUMCP_HOME/capabilities/<fingerprint>.json after first run

When Phase 1 is complete, STOP and report back with:
  - List of tools exposed
  - Capability tiers detected against my test account
  - Any divergences from TOOLS.md you encountered
  - Whether Claude Desktop end-to-end works (with a sample interaction transcript)

Do not start Phase 2. We will review and plan it deliberately.

Begin.
```

---

## What to do while Phase 1 runs

Probably 30-60 minutes of agent time. Useful background tasks:

1. **Open the GitHub repo in your browser** — `https://github.com/baliles/herokumcp/actions` — to watch CI runs as Claude Code pushes commits.
2. **Skim AUTH.md and DEPLOYMENT.md** if you haven't already. You won't need them for Phase 1, but Phase 4 will lean heavily on them and prior familiarity helps.
3. **Confirm the Heroku test account has enough surface.** If `heroku apps` shows zero apps, create one now:
   ```bash
   heroku create herokumcp-test-app --region us
   heroku config:set HELLO=world -a herokumcp-test-app
   heroku ps:scale web=0 -a herokumcp-test-app
   ```

## When Phase 1 reports done

Run the acceptance checks yourself:

```bash
# Local checks
pnpm -r typecheck && pnpm -r lint && pnpm -r format:check && pnpm -r test && pnpm -r build
export HEROKUMCP_TEST_TOKEN="HRKU-..."
pnpm -r test:integration

# CI check
git push  # if anything uncommitted
gh run watch
```

Then **the actual smoke test**: restart Claude Desktop, open a conversation, and ask:

> What Heroku apps do I have?

If Claude Desktop comes back with your actual app list — read from your real Heroku account through the MCP you just built — Phase 1 is genuinely done.

If anything is off — tools not showing, wrong responses, capability gating misbehaving — paste the symptoms back into the planning chat (not the build session) and we'll diagnose.

## After Phase 1

Same shape as before: review divergences, commit (if Claude Code hasn't already), changeset (`pnpm changeset` → select `@heroku-mcp/platform`, **minor**, write summary), tag `platform-v0.1.0`, push, and come back here to plan Phase 2. Phase 2 introduces destructive writes and the confirm pattern — worth a deliberate design conversation before implementation.
