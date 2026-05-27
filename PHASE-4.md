# Phase 4 — Handoff Prompt for Claude Code

> Drop into the repo at `PHASE-4.md`. Open a **fresh** Claude Code session and paste the prompt block. Do not continue any previous session.

## What Phase 4 is

The architecturally biggest phase in the project. Phase 4 takes the stdio-mode platform MCP and makes it deployable as a hosted HTTP service that anyone can sign into with their Heroku account. After Phase 4, customers can host their own MCP on Heroku, sign in, get a connection token, paste it into Claude Desktop, and use the MCP without running Node locally.

Concretely, Phase 4 adds:

1. **HTTP transport** — speak MCP over Streamable HTTP via Hono
2. **Heroku OAuth sign-in** with PKCE (`write-protected` scope default, configurable)
3. **Persistent encrypted token storage** in Postgres (envelope encryption, master KEK, per-user DEKs)
4. **MCP connection tokens** (`hmcp_` prefix, 256-bit random)
5. **Sign-in web UI** with self-rotation and "Sign out everywhere"
6. **Access control** via `MCP_ALLOWED_EMAILS` / `MCP_ALLOWED_TEAMS`
7. **Full audit log** persisted to DB, viewable per-user
8. **Admin web UI** for operators (gated by `MCP_ADMIN_EMAILS`)
9. **Admin CLI** (`herokumcp-admin` binary)
10. **`dynos_run` in buffered mode** (deferred from Phase 2a, now unblocked by HTTP transport)

This is security-sensitive code. Every Phase 4 decision below was deliberated; do not deviate without raising the concern first.

## Prerequisites

```bash
cd /Users/maxpro/Desktop/Github/herokumcp
git status                                  # clean working tree
git log --oneline | head -5
# Should show recent commits ending at tag platform-v0.4.0

pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r format:check && pnpm -r test
# All green — 274 core + 209 platform = 483 tests

pnpm -r test:integration
# All green with HEROKUMCP_TEST_TOKEN exported
```

## New packages and files

Phase 4 introduces **two new packages** to the monorepo:

```
packages/
├── core/                    (existing — minor additions only)
├── platform-mcp/            (existing — minor additions only)
├── http-server/             ★ NEW — the Hono app, OAuth, web UI, admin views
└── admin-cli/               ★ NEW — the herokumcp-admin binary

```

Reasoning for the split:
- `http-server` is the deployable web application
- `admin-cli` is a separate Node binary operators run via `heroku ps:exec` or locally with `DATABASE_URL` set
- Both depend on `@heroku-mcp/core` and reuse `@heroku-mcp/platform`'s tool registration

## Heroku-side OAuth setup (operator must do once)

Before deploying, the operator registers an OAuth client at https://dashboard.heroku.com/account/applications. The client gets `client_id` and `client_secret`. These go into env vars at deploy time. PHASE-5.md (Heroku Button) will document this; for now, Phase 4 just consumes the env vars.

---

## The prompt to paste into a fresh Claude Code session

```
Phase 3 is complete and tagged at platform-v0.4.0. All CI green, 240 tools shipped. Begin Phase 4 per ARCHITECTURE.md §15 and the locked design decisions below.

Read these documents in this order before writing any code:

  1. ARCHITECTURE.md §3 (repo layout), §7 (auth), §8 (tool conventions), §9 (security model), §15 (delivery phases)
  2. AUTH.md — the canonical design for hosted authentication and token storage
  3. DEPLOYMENT.md — what the operator-facing experience must support
  4. TOOLS.md — the existing tool surface that Phase 4 makes accessible over HTTP
  5. NAMING.md — naming conventions (HEROKUMCP_*, @heroku-mcp/*)
  6. notes/divergences.md — running log

Then explore packages/core/src/, packages/platform-mcp/src/server.ts, packages/platform-mcp/src/index-stdio.ts. The MCP protocol implementation lives in @modelcontextprotocol/sdk; the Streamable HTTP transport class is StreamableHTTPServerTransport.

============================================================
DESIGN DECISIONS — authoritative for Phase 4
============================================================

DECISION 1 — HTTP framework: Hono
----------------------------------
Use Hono with @hono/node-server. Hono is the framework; @hono/node-server runs it on Heroku's Node runtime. Standard buildpack, standard PORT env var, no special deployment shape required.

DECISION 2 — OAuth scope and flow
----------------------------------
Default scope: `write-protected`. Configurable via env var HEROKUMCP_OAUTH_SCOPE.

Flow: OAuth 2.0 Authorization Code with PKCE.
- /sign-in initiates the flow with a state token + PKCE challenge
- Redirect to Heroku's authorize endpoint: https://id.heroku.com/oauth/authorize
- /oauth/callback receives the auth code
- Exchange code at https://id.heroku.com/oauth/token for access + refresh tokens
- Fetch user info from GET /account on api.heroku.com
- Issue an hmcp_ connection token and show it to the user

OAuth client_id and client_secret come from env vars HEROKUMCP_OAUTH_CLIENT_ID and HEROKUMCP_OAUTH_CLIENT_SECRET. Both required at startup; refuse to start with a clear error if missing.

DECISION 3 — Token encryption: envelope encryption with master KEK
-------------------------------------------------------------------
Master KEK: HEROKUMCP_MASTER_KEY env var, 32 bytes base64-encoded. Operator generates with `openssl rand -base64 32`. Required at startup; refuse to start if missing or malformed.

Per-user DEK: 32 bytes randomly generated when the user signs in for the first time. DEK is AES-256-GCM-encrypted with the master KEK. Stored as bytea in the heroku_tokens table.

Token encryption: Heroku access_token and refresh_token are AES-256-GCM-encrypted with the user's DEK. Both stored as bytea.

If the master key is lost or rotated incorrectly, all stored tokens become unusable and all users must re-sign-in. Document this clearly in /admin/status and DEPLOYMENT.md.

Implementation: a new packages/core/src/crypto.ts module with these primitives:
  - generateDek(): Uint8Array
  - encryptWithKek(plaintext, kek): { ciphertext, iv, tag }
  - decryptWithKek(ciphertext, iv, tag, kek): plaintext
  - encryptWithDek(plaintext, dek): { ciphertext, iv, tag }
  - decryptWithDek(ciphertext, iv, tag, dek): plaintext
  - encodeForStorage(parts): single bytea blob containing iv+tag+ciphertext
  - decodeFromStorage(blob): { iv, tag, ciphertext }
Unit tests must cover: round-trip, tampered ciphertext rejection, tampered iv rejection, tampered tag rejection, wrong-key rejection.

DECISION 4 — Connection tokens
-------------------------------
Format: `hmcp_` + 43 chars base64url (256 bits of entropy via crypto.randomBytes(32) + base64url).
Storage: SHA-256 hash of the token as bytea. The plaintext token is never stored — shown to the user once at issuance.
Lifetime: no expiration by default. Self-rotation supported via "Sign out everywhere" button which revokes ALL the user's tokens. Re-signing-in issues a new token; previous tokens marked revoked.
Auth: every MCP HTTP request must include Authorization: Bearer hmcp_... — middleware validates against the connection_tokens table and looks up the user.

DECISION 5 — Sessions: encrypted cookies for OAuth flow
--------------------------------------------------------
Short-lived (5 min) signed+encrypted cookie carries the OAuth flow state between /sign-in and /oauth/callback: { state, pkceVerifier, redirectAfterLogin, createdAt }. Encryption with master KEK. Cookie name: hmcp_oauth_flow. HttpOnly, Secure, SameSite=Lax.

After successful sign-in: a longer-lived session cookie (30 days, sliding expiration) holds { userId, signedInAt }, also signed+encrypted with the master KEK. Cookie name: hmcp_session. This session is for the WEB UI only (sign-in success page, /audit viewer, admin views). The MCP HTTP API does NOT use this cookie — it uses the hmcp_ Bearer token.

DECISION 6 — Full audit log persisted to DB
--------------------------------------------
Every observable event is logged:
- Authenticated identity per request (user_id, email, hmcp_token_id)
- Connection context: client name + version (from MCP initialize handshake), MCP protocol version, session start
- Tool calls: tool_name, sanitized arguments (passwords/tokens redacted via existing redact.ts), dry_run flag, confirm value presence (NOT the value itself), result status, response time ms, Heroku request_id
- Mutations: for write tools, the full Heroku request (method, path, sanitized body) and Heroku response code
- Auth events: sign-in, sign-out, token issuance, token revocation, denied access attempts (with reason: not in allowed_emails / not in allowed_teams)
- System events: server start, server stop, master key fingerprint check on startup, DB migration runs, retention prune runs

We do NOT log the user's natural-language prompts to Claude — the MCP cannot observe them. This is structural; document it in the audit viewer UI.

Viewer:
- /audit for signed-in user, showing only their own entries, filterable by date / tool / status, paginated 50 per page
- CSV export of user's own audit history
- Per-user pruning: user can delete their own entries older than X days
- System retention: env var HEROKUMCP_AUDIT_RETENTION_DAYS (default null = forever; if set, daily cron prunes)
- Admin CLI: `herokumcp-admin audit prune --before <date>` for manual pruning
- Admin web UI: full audit log across all users (see Decision 9)

DECISION 7 — Access control with required admin contact
--------------------------------------------------------
Env vars:
- HEROKUMCP_ADMIN_CONTACT — REQUIRED at startup. Refuse to start with clear error if missing. Heroku Button manifest will mark this required in PHASE-5.
- MCP_ALLOWED_EMAILS — optional, comma-separated. If set, only these emails can sign in.
- MCP_ALLOWED_TEAMS — optional, comma-separated. If set, user must be in ≥1 of these Heroku teams.
- If both MCP_ALLOWED_EMAILS and MCP_ALLOWED_TEAMS are unset: anyone with a Heroku account can sign in.
- If both set: user must match BOTH (email allowed AND in ≥1 allowed team).

Denial page format (when access is denied):

  Access denied.

  This MCP deployment is restricted to:
    - [if MCP_ALLOWED_TEAMS set] Members of: <team-name-1>, <team-name-2>
    - [if MCP_ALLOWED_EMAILS set] Email addresses: <privacy-masked list — e.g. "j***@stratis.com, a***@stratis.com">

  Your sign-in identity:
    Email: <email>
    Heroku ID: <heroku_id>
    Teams: <teams the user IS in>

  Reason for denial: <specific reason: "your email is not on the allowlist" / "you are not a member of any allowed team" / etc.>

  If you believe you should have access, contact: <HEROKUMCP_ADMIN_CONTACT>

Privacy mask: keep first character, replace rest of local part with three asterisks, keep domain. "alice@stratis.com" → "a***@stratis.com".

DECISION 8 — dynos_run in buffered mode
----------------------------------------
The dynos_run tool is implemented in Phase 4 (deferred from Phase 2a). Mode: buffered, not interactive.

Inputs:
- app: string (required)
- command: string (required) — the shell command to run
- size: enum of dyno sizes (default 'standard-1x')
- env: optional Record<string,string> of additional env vars
- max_duration_seconds: number (default 30, max 60) — how long to wait for output before timing out
- max_output_bytes: number (default 65536, max 1048576) — truncate output past this

Flow:
1. POST /apps/{app}/dynos with { command, attach: true, size, env, type: 'run' }
2. Response includes attach_url (WebSocket rendezvous)
3. Open the WebSocket using ws library
4. Read until WS closes OR max_duration_seconds elapsed OR max_output_bytes reached
5. Return { output: string, exit_code: number | null, truncated: boolean, timed_out: boolean, duration_ms: number }

For interactive sessions, the response includes guidance: "For interactive dyno sessions, use `heroku run` from your local CLI." dynos_run is destructive=false (doesn't change state), but supports dry_run which returns the would-be request without executing.

DECISION 9 — Admin web UI inside same app, role-gated
------------------------------------------------------
New env var: MCP_ADMIN_EMAILS (comma-separated). Users whose email matches get admin nav items in the web UI.

Admin pages:
- /admin/users — list all users (email, heroku_id, signed_in_at, last_seen_at, active token count, action: "Revoke all tokens")
- /admin/tokens — list all connection tokens across all users (token id, user email, issued_at, last_used_at, label, revoked_at, action: "Revoke")
- /admin/audit — full audit log with filters (user, tool, date range, status), pagination 100/page, CSV export across all users
- /admin/status — deployment health: Heroku API reachability (a real probe), DB connection, current token count, recent error count, master key fingerprint (SHA-256 of the key, first 8 chars, for verification not the key itself)
- /admin/config — read-only view of effective env config (all HEROKUMCP_* and MCP_* env vars with secrets masked as "***")

All admin pages: same Hono app, same session cookie, role check via middleware that compares signedInUser.email to MCP_ADMIN_EMAILS list. Non-admin gets 404 (not 403 — don't reveal admin pages exist).

============================================================
WEB UI PAGES
============================================================

Public:
- /         — landing page (what is this, sign-in button, link to source repo)
- /sign-in  — initiates OAuth flow
- /oauth/callback — handles Heroku redirect

Authenticated:
- /me       — your account: email, Heroku ID, default team, when you signed in
              - your connection token if first sign-in or token was just rotated (one-time display)
              - "Show me Claude Desktop config snippet" button (copy-paste-ready JSON)
              - "Sign out everywhere" button (revokes all hmcp_ tokens for this user)
              - link to /audit
- /audit    — your audit log: paginated, filterable, exportable, prunable

Admin (gated on MCP_ADMIN_EMAILS):
- /admin/users
- /admin/tokens
- /admin/audit
- /admin/status
- /admin/config

UI style: minimal HTML + a small amount of inline CSS. NO frontend framework, NO build step for the UI. Server-rendered HTML via Hono's html template helper. Maybe a tiny bit of vanilla JS for copy-to-clipboard buttons. This is an operator/developer UI; we want it boring and unbreakable.

============================================================
DATABASE SCHEMA
============================================================

Use node-postgres (pg) with a thin migration system. Migration files in packages/http-server/migrations/, numbered 0001_, 0002_, etc. Each is a single SQL file with up/down sections (or two files per migration if simpler).

Migration 0001 — initial schema:

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  heroku_id       text UNIQUE NOT NULL,
  email           text NOT NULL,
  default_team    text,
  signed_in_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_email_idx ON users(email);

CREATE TABLE heroku_tokens (
  user_id                   uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  encrypted_access_token    bytea NOT NULL,
  encrypted_refresh_token   bytea NOT NULL,
  encrypted_dek             bytea NOT NULL,
  expires_at                timestamptz NOT NULL,
  refreshed_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE connection_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    bytea NOT NULL UNIQUE,
  label         text,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX connection_tokens_user_idx ON connection_tokens(user_id) WHERE revoked_at IS NULL;
CREATE INDEX connection_tokens_hash_idx ON connection_tokens(token_hash) WHERE revoked_at IS NULL;

CREATE TABLE audit_log (
  id             bigserial PRIMARY KEY,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  event_category text NOT NULL,        -- 'tool_call', 'auth', 'system'
  event_name     text NOT NULL,         -- e.g. 'apps_delete', 'sign_in', 'token_issued', 'access_denied'
  status         text NOT NULL,         -- 'ok', 'error', 'rejected'
  request_id     text,                  -- the X-Request-ID we log to Heroku
  duration_ms    integer,
  client_name    text,                  -- e.g. 'claude-desktop'
  client_version text,
  details        jsonb                  -- structured detail blob, sanitized
);
CREATE INDEX audit_log_user_occurred_idx ON audit_log(user_id, occurred_at DESC);
CREATE INDEX audit_log_occurred_idx ON audit_log(occurred_at DESC);
CREATE INDEX audit_log_event_idx ON audit_log(event_category, event_name);

Migrations run on server start. The CLI also has a `herokumcp-admin db migrate` command for manual control.

============================================================
PACKAGE STRUCTURE
============================================================

packages/http-server/
├── package.json              — depends on @heroku-mcp/core, @heroku-mcp/platform, hono, @hono/node-server, pg, ws, zod
├── tsup.config.ts            — bundles to dist/index.js
├── tsconfig.json
├── README.md
├── migrations/
│   └── 0001_initial.sql
├── src/
│   ├── index.ts              — entrypoint
│   ├── app.ts                — Hono app construction, route wiring
│   ├── config.ts             — env var loading and validation; refuses to start on missing required vars
│   ├── db/
│   │   ├── pool.ts           — pg Pool with reasonable defaults
│   │   ├── migrate.ts        — migration runner
│   │   └── repos/
│   │       ├── users.ts
│   │       ├── heroku-tokens.ts
│   │       ├── connection-tokens.ts
│   │       └── audit-log.ts
│   ├── crypto/
│   │   └── envelope.ts       — re-exports from @heroku-mcp/core/crypto + DB-specific helpers
│   ├── oauth/
│   │   ├── heroku.ts         — Heroku OAuth client
│   │   ├── pkce.ts           — PKCE challenge generation
│   │   └── flow.ts           — orchestrates /sign-in → /oauth/callback
│   ├── auth/
│   │   ├── connection-token.ts  — issue, verify, revoke
│   │   ├── session.ts        — encrypted cookie session for web UI
│   │   └── middleware.ts     — Hono middleware: bearer-auth (MCP), session-auth (web), admin-role
│   ├── access/
│   │   └── allowlist.ts      — MCP_ALLOWED_EMAILS / MCP_ALLOWED_TEAMS / MCP_ADMIN_EMAILS evaluation
│   ├── mcp/
│   │   ├── transport.ts      — StreamableHTTPServerTransport setup per session
│   │   ├── audit-wrapper.ts  — wraps registered tools to write audit_log entries
│   │   └── dynos-run.ts      — buffered dyno-run implementation
│   ├── routes/
│   │   ├── public.ts         — /, /sign-in, /oauth/callback
│   │   ├── me.ts             — /me
│   │   ├── audit.ts          — /audit
│   │   ├── admin.ts          — /admin/*
│   │   └── mcp.ts            — /mcp (the actual MCP HTTP endpoint)
│   └── views/
│       ├── layout.ts         — common HTML chrome
│       ├── pages.ts          — each page as a function returning an HTML string
│       └── styles.ts         — inline CSS string
└── test/
    ├── crypto.test.ts
    ├── oauth.test.ts (mocked Heroku)
    ├── auth-middleware.test.ts
    ├── allowlist.test.ts
    ├── dynos-run.test.ts (mocked WebSocket)
    ├── audit-wrapper.test.ts
    ├── routes/
    │   ├── public.test.ts
    │   ├── me.test.ts
    │   ├── audit.test.ts
    │   ├── admin.test.ts
    │   └── mcp.test.ts
    └── integration/
        └── e2e.integration.test.ts — full sign-in → tool-call flow with mocked Heroku + real Postgres (via testcontainers OR a pre-provisioned test DB)

packages/admin-cli/
├── package.json              — depends on @heroku-mcp/core, pg, commander
├── tsup.config.ts            — bundles to dist/index.js with shebang #!/usr/bin/env node
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts              — commander setup, command dispatch
│   ├── commands/
│   │   ├── users.ts          — list, revoke
│   │   ├── tokens.ts         — list, revoke
│   │   ├── audit.ts          — tail, prune
│   │   ├── status.ts
│   │   ├── db.ts             — migrate, rollback
│   │   └── keys.ts           — rotate-master (Phase 4 stub; full impl deferred to Phase 10)
│   └── shared/
│       └── db.ts             — pg pool initialized from DATABASE_URL env var
└── test/
    └── commands/*.test.ts    — basic CRUD-against-test-DB tests

============================================================
INTEGRATION OF EXISTING TOOLS
============================================================

The 240 existing tools from Phases 1-3 are reused unchanged. The http-server package imports their registration functions from @heroku-mcp/platform and wires them to an HTTP-transport MCP server instead of stdio. The capability probing logic, the registerWriteTool helper, the canonical-name confirm pattern — all carry over without modification.

NEW: an audit wrapper around tool registration. Every registered tool gets wrapped so that before-call and after-call hooks write to audit_log. The wrapper:
- Captures the call args
- Sanitizes them via @heroku-mcp/core/redact (existing module)
- Records the user_id (from the bearer token middleware)
- Records the client (from session init)
- Records the result status and duration
- Writes one audit_log row per tool call

The wrapper sits between the MCP transport and the registered tool function. Implementation in packages/http-server/src/mcp/audit-wrapper.ts.

============================================================
EXISTING STDIO MODE PRESERVATION
============================================================

The packages/platform-mcp/dist/index-stdio.js binary continues to work as before. Phase 4 does NOT replace stdio mode; it adds HTTP mode as an alternative. The stdio binary uses the HEROKUMCP_TOKEN env var directly (the user's Heroku token). The HTTP server uses connection tokens (hmcp_*) that map to encrypted stored Heroku tokens.

Both modes coexist. Documentation should clarify: stdio for individual local use; HTTP for hosted multi-user deployments.

============================================================
TESTING STRATEGY
============================================================

Unit tests: every Phase 4 module gets unit tests. Mocked Heroku API for OAuth and tool calls. Mocked Postgres via vitest's vi.mock for repo layer tests. Real Postgres in integration tests.

Integration tests in packages/http-server/test/integration/e2e.integration.test.ts:
- Spin up the Hono app against a real Postgres instance
- Mock Heroku's OAuth endpoints (use msw or nock — pick one and use it consistently)
- Mock api.heroku.com responses for tool calls
- Walk through: sign-in flow, token issuance, MCP call with bearer auth, audit log persistence, sign-out

The integration test needs a real Postgres. Two options:
- testcontainers-node (spawns ephemeral Postgres in Docker) — preferred if Docker is available in CI
- Pre-provisioned local test DB (developer sets HEROKUMCP_TEST_DATABASE_URL env var)

Default to testcontainers; document the fallback.

CI: add a new integration job in .github/workflows/ci.yml that runs against Postgres in a service container. Existing live api.heroku.com integration tests continue to run (those don't need Phase 4 changes).

============================================================
IMPLEMENTATION SEQUENCE
============================================================

This is large. Implement in this order to minimize integration pain:

1. Crypto primitives in @heroku-mcp/core/src/crypto.ts. Unit tests pass before moving on.

2. Create packages/http-server/ skeleton (package.json, tsup config, basic Hono app with /health endpoint). Verify pnpm build works.

3. DB schema + migrations + repos. Unit tests for repos using a real test DB. Get all CRUD round-tripping.

4. OAuth flow: PKCE module, Heroku OAuth client, /sign-in, /oauth/callback. Mocked Heroku in tests.

5. Connection token issuance + validation. Auth middleware. Bearer-auth and session-auth both working.

6. Access control: allowlist evaluator, denial page, HEROKUMCP_ADMIN_CONTACT enforcement at startup.

7. MCP HTTP transport: integrate StreamableHTTPServerTransport, wire up the 240 existing tools, verify a real MCP client (Claude Desktop pointed at localhost) can complete the handshake and call a tool.

8. Audit log: wrapper around tool registration, /audit viewer, CSV export, pruning.

9. Admin web UI: /admin/users, /admin/tokens, /admin/audit, /admin/status, /admin/config. Role gating via MCP_ADMIN_EMAILS.

10. /me page: token display, Claude Desktop config snippet, "Sign out everywhere".

11. dynos_run buffered implementation. WebSocket via ws. Integration with the existing apps-writes tool registration.

12. Admin CLI: users, tokens, audit, status commands. Migration runner.

13. Live integration test with real Postgres, mocked Heroku.

14. README and DEPLOYMENT.md updates documenting the hosted mode.

15. Local smoke test: spin up the server with `pnpm --filter @heroku-mcp/http-server start`, point a browser at http://localhost:3000, complete a real sign-in against your test Heroku OAuth client, verify the connection token works against Claude Desktop pointed at http://localhost:3000/mcp.

============================================================
THINGS TO ASK RATHER THAN GUESS
============================================================

- If a Heroku API response shape differs from what AUTH.md documents, surface it and ask before deviating.
- Hono's session cookie implementation choices: pick a vetted library (hono/cookie + your own encryption helpers, OR a tiny session library like @hono/session if it exists). If it doesn't exist, build it on hono/cookie + the crypto module — don't pull in a heavy express-session-style dependency.
- For the audit log JSON details column, schema is intentionally flexible. Surface what fields you put in it; we want consistency across tool-call entries.
- testcontainers-node may not work on all developer machines. Surface the fallback path before committing.

============================================================
THINGS TO JUST DO
============================================================

- Match the patterns from Phases 0-3: tsdoc, eslint, prettier, vitest, same file organization conventions
- Use zod for all env var validation, all OAuth response validation, all request body validation in routes
- Connection token comparison MUST be constant-time (use crypto.timingSafeEqual). Same for session cookie verification.
- Cookies MUST be HttpOnly, Secure (in production), SameSite=Lax for the session cookie and SameSite=Strict for the OAuth flow cookie
- All bytea data in Postgres goes through prepared statements with the pg driver's native bytea handling. No string concatenation for SQL anywhere.
- Every error response in the MCP HTTP layer uses the same envelope shape as Phase 1-3 tools: { ok: false, error: { kind, message, details? } }
- The Hono app's error handler MUST NOT leak stack traces in production. Log them server-side via the audit_log system_events; return a sanitized "internal server error" to the client.
- Inline CSS only. No bundler for the web UI. Total CSS surface should be < 200 lines.

============================================================
ACCEPTANCE CRITERIA FOR PHASE 4
============================================================

Locally:
- pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r format:check && pnpm -r test all green
- New http-server test suite: crypto, oauth, auth middleware, allowlist, dynos-run, audit-wrapper, all route tests
- New admin-cli test suite: each command exercised
- pnpm -r test:integration green INCLUDING the new http-server e2e integration test
- The existing stdio binary at packages/platform-mcp/dist/index-stdio.js continues to work unchanged

Manual end-to-end (do not run as the agent — surface as a requirement for the human reviewer):

1. Set up local Postgres (Docker, Heroku Postgres, or local install)
2. Register a Heroku OAuth client at https://dashboard.heroku.com/account/applications with redirect URI http://localhost:3000/oauth/callback
3. Set env vars:
     DATABASE_URL=postgres://...
     HEROKUMCP_MASTER_KEY=$(openssl rand -base64 32)
     HEROKUMCP_OAUTH_CLIENT_ID=...
     HEROKUMCP_OAUTH_CLIENT_SECRET=...
     HEROKUMCP_ADMIN_CONTACT=admin@example.com
     MCP_ADMIN_EMAILS=your@email.com
4. Start: pnpm --filter @heroku-mcp/http-server start
5. Migrations should run on start; verify with herokumcp-admin db status
6. Visit http://localhost:3000 in a browser; click Sign in with Heroku
7. Complete OAuth; you should land on /me with a fresh hmcp_ token
8. Verify the connection token works:
   - Update Claude Desktop config to point at the HTTP endpoint with the bearer token
   - Open Claude Desktop, ask "What Heroku apps do I have?"
   - Should work end-to-end
9. Verify /audit shows the tool call
10. Visit /admin/users — you should see yourself
11. Verify /admin/audit shows the same tool call
12. Click "Sign out everywhere" on /me; verify the token stops working on the next Claude Desktop tool call

When Phase 4 is complete, STOP and report back with:
  - Total LoC added (rough)
  - New test count (target: 100+ new tests across http-server and admin-cli)
  - Coverage of all 10 decisions above with explicit citation of where each is implemented
  - Any divergences added to notes/divergences.md
  - Confirmation that stdio mode still works
  - Confirmation that all 240 existing tools are exposed via the HTTP endpoint
  - The bundled http-server binary size
  - Smoke-test instructions for the human reviewer (the 12 steps above, adapted to anything you changed)

Do not start Phase 5. We will plan Phase 5 (Heroku Button deployment repo) separately — it's a small phase that builds on Phase 4's deployed shape.

Begin.
```

---

## What to expect

Phase 4 is the largest phase by code volume in the project. Estimate: 4-6 hours of agent time. Could be longer if the OAuth integration has surprises or if testcontainers doesn't cooperate.

The agent will need to:
- Make decisions about library specifics (which Hono cookie helper, which migration runner approach)
- Surface those decisions rather than guess
- Add 100+ new tests
- Touch every layer: crypto, DB, OAuth, HTTP, MCP transport, web UI, CLI

This is the security-critical phase. Pay extra attention to the review when it reports back. Specific things to double-check before tagging:

1. **Connection token comparison is constant-time** — `crypto.timingSafeEqual`, not `===`
2. **Master key is required at startup and the server refuses to start without it** — not a soft warning
3. **Cookies have correct flags** — HttpOnly always, Secure in production, SameSite values per Decision 5
4. **OAuth state cookie is single-use** — must be cleared after /oauth/callback regardless of success
5. **Admin pages return 404, not 403, for non-admins** — don't reveal that admin pages exist
6. **The connection token is shown ONCE** — never logged, never retrievable after the user navigates away
7. **PKCE verifier is verified server-side** — not just sent and ignored
8. **Encrypted blobs include authentication tags** — AES-GCM, not AES-CBC

## Smoke tests when Claude Code finishes

```bash
pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r format:check && pnpm -r test
pnpm -r test:integration
```

Then the manual end-to-end against a local Heroku OAuth client and local Postgres. See the 12-step manual procedure in the prompt above.

## After Phase 4

1. Verify all checks green
2. Verify manual end-to-end (don't skip this; it's the only real test of OAuth)
3. Commit and tag `platform-v0.5.0` and add a new tag `http-server-v0.1.0` for the new package
4. Push, watch CI
5. Come back here to plan Phase 5 (Heroku Button repo)

Phase 5 is small — it's mostly a `herokumcp-platform-deploy` repo with an `app.json` that prompts for the env vars Phase 4 needs. Once Phase 4 ships, Phase 5 will fit in an hour.

