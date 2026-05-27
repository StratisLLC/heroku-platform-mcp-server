# Phase 4.5 — OAuth Provider Layer (Claude Desktop Custom Connector support)

**Status:** Design locked, ready for implementation
**Predecessor:** `http-server-v0.1.0` (Phase 4)
**Successor tag:** `http-server-v0.2.0`
**Repo:** `github.com/baliles/herokumcp` (will move to Stratis Global)

---

## Why this phase exists

Phase 4 shipped a hosted MCP server that authenticates clients with bearer tokens (`hmcp_...`) issued via a manual sign-in + copy-paste flow at `/me`. This works for:

- Claude Code (`claude mcp add --transport http --header "Authorization: Bearer hmcp_..."`)
- MCP Inspector + curl
- Any client that accepts a custom header

It does **NOT** work for Claude Desktop's **Custom Connector** UI. Claude Desktop expects to be an OAuth 2.1 client of the MCP server — it registers itself via Dynamic Client Registration, completes a standard OAuth authorization-code + PKCE flow, and receives an access token it manages internally. There is no field in the Custom Connector dialog for a pre-issued bearer token.

The MCP authorization spec (`2025-03-26` and `2025-06-18`) explicitly requires this OAuth flow for any server that wants to be a first-class Custom Connector. Phase 4.5 makes our server compliant.

**Key principle:** the OAuth flow is additive. The bearer-token path stays. Same `hmcp_` token under the hood — two issuance paths, two presentation surfaces.

---

## Design decisions (locked)

These were debated and locked before implementation begins.

### D1 — Dynamic Client Registration is open

`POST /oauth/register` accepts any well-formed DCR request and returns a freshly-minted `client_id` and `client_secret`. No pre-shared key, no admin approval, no allowlist at the registration layer.

**Rationale:** The actual security boundary is `MCP_ALLOWED_EMAILS` / `MCP_ALLOWED_TEAMS` at user-auth time. A registered DCR client with no valid user behind it gets nothing — it can't complete the authorization code flow without a real Heroku-authenticated user, and that user must pass the allowlist. Gating DCR adds friction without security.

### D2 — Consent screen is minimal, skipped for allowlisted users

After the user signs in via Heroku and returns to our `/oauth/callback`, we determine:

- If user email is in `MCP_ALLOWED_EMAILS` OR user is a member of any team in `MCP_ALLOWED_TEAMS` → **skip consent screen**, immediately issue authorization code and redirect to Claude.
- Otherwise → show consent screen: "Claude Desktop wants to access your Heroku account through herokumcp. [Allow] [Deny]"

**Rationale:** Operators running private team deployments have pre-authorized their users; making them click "Allow" every time is annoying. Operators running open deployments need the consent screen for MCP-spec compliance and security hygiene.

### D3 — Two-tier token lifetimes

| Token kind | Lifetime | Refresh? | Issued by |
|---|---|---|---|
| Bearer (`hmcp_...`) — manual path | Never expires | N/A | `/me` page |
| OAuth access token — Custom Connector path | 1 hour | Yes, via refresh_token | `/oauth/token` |
| OAuth refresh token | 90 days, rotated on use | N/A | `/oauth/token` |

**Rationale:** The bearer path is for power users who want a long-lived token they can paste into a config file. The OAuth path is for end-user clients that expect short-lived access + refresh, per RFC 6749 and OAuth 2.1 best practice. Same `hmcp_<random>` token format under the hood — the access_token is just stored with an `expires_at` and a linked refresh_token row.

### D4 — `/me` page shows connected clients

After Phase 4.5, the `/me` page has two sections:

1. **Connected applications** (new, primary) — list of DCR clients linked to this user. Each row shows: client name (from DCR `client_name` field), first-seen date, last-active date, [Revoke] button.
2. **Advanced: bearer token** (collapsed by default, kept for compatibility) — what `/me` currently shows. Click-to-expand "I need a bearer token for Claude Code or curl" disclosure.

**Rationale:** Most users on Claude Desktop just need to see "yes, my Claude Desktop is connected" and have a per-device revoke button. Bearer-token users find what they need under "Advanced."

### D5 — Storage schema (migration `0002_oauth.sql`)

Three new tables:

```sql
-- DCR-registered clients
CREATE TABLE oauth_clients (
  client_id              TEXT PRIMARY KEY,                    -- public client id, 32 hex chars
  client_secret_hash     BYTEA NOT NULL,                      -- SHA-256 of client_secret
  client_name            TEXT,                                -- from DCR request "client_name"
  redirect_uris          TEXT[] NOT NULL,                     -- registered redirect URIs
  grant_types            TEXT[] NOT NULL DEFAULT ARRAY['authorization_code', 'refresh_token'],
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'client_secret_basic',
  user_id                UUID REFERENCES users(id),           -- nullable; bound on first successful authorize
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at           TIMESTAMPTZ,
  revoked_at             TIMESTAMPTZ                          -- set when user clicks "Revoke" in /me
);

-- Pending authorization codes (short-lived, single-use)
CREATE TABLE oauth_authorizations (
  code_hash              BYTEA PRIMARY KEY,                   -- SHA-256 of the authorization code
  client_id              TEXT NOT NULL REFERENCES oauth_clients(client_id),
  user_id                UUID NOT NULL REFERENCES users(id),
  redirect_uri           TEXT NOT NULL,
  code_challenge         TEXT NOT NULL,                       -- PKCE S256 challenge
  code_challenge_method  TEXT NOT NULL DEFAULT 'S256',
  scope                  TEXT,                                -- optional; ignored on our side for now
  expires_at             TIMESTAMPTZ NOT NULL,                -- code valid for 10 minutes
  used_at                TIMESTAMPTZ                          -- prevents replay; one-time use
);

-- Issued OAuth tokens
CREATE TABLE oauth_tokens (
  access_token_hash      BYTEA PRIMARY KEY,                   -- SHA-256 of access_token (hmcp_...)
  refresh_token_hash     BYTEA NOT NULL UNIQUE,               -- SHA-256 of refresh_token (hmcprt_...)
  client_id              TEXT NOT NULL REFERENCES oauth_clients(client_id),
  user_id                UUID NOT NULL REFERENCES users(id),
  expires_at             TIMESTAMPTZ NOT NULL,                -- access_token expiry (1h)
  refresh_expires_at     TIMESTAMPTZ NOT NULL,                -- refresh_token expiry (90d)
  revoked_at             TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_oauth_tokens_user_client ON oauth_tokens (user_id, client_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_oauth_authorizations_expiry ON oauth_authorizations (expires_at);
```

Notes:
- Existing `connection_tokens` table (bearer-token path) is untouched.
- Both `connection_tokens` and `oauth_tokens` store SHA-256 hashes of `hmcp_`-prefixed tokens. The middleware tries `oauth_tokens` first, falls back to `connection_tokens`, so both flows accept the same `Authorization: Bearer hmcp_...` header.
- The refresh token uses a different prefix `hmcprt_` (Heroku-MCP Refresh Token) so logs and inspection can distinguish them at a glance.

### D6 — Bearer token path is "Advanced," OAuth is the documented default

Documentation hierarchy after this phase:

- **README.md** leads with: "Connect from Claude Desktop → Settings → Connectors → Add custom connector → paste `https://<your-server>/mcp`. Click Connect, sign in with Heroku, you're done."
- **README.md** secondary section: "Advanced: Bearer token auth for Claude Code, MCP Inspector, curl, scripting."
- The `/me` page mirrors this: connected clients section primary, bearer-token section collapsed.

**Rationale:** Most users hit Claude Desktop first. The `/me` bearer-token flow is now a power-user / developer-tooling path.

### D7 — Bearer tokens and OAuth tokens coexist per user

When a user with an existing bearer token (from Phase 4 `/me`) connects from Claude Desktop, the new OAuth-issued token is **independent and additive**. The bearer token keeps working; the OAuth token works in parallel. Different clients, different lifecycles, both authenticate the same user against the same Heroku account.

A user can revoke either independently from `/me`:
- "Sign out everywhere" (existing button) revokes the bearer token only
- Per-client "Revoke" buttons in the new Connected Applications section revoke individual OAuth client tokens

**Rationale:** The user explicitly chose to issue the bearer token; Claude Desktop connecting shouldn't undo that. Power users who run Claude Code AND Claude Desktop need both.

---

## Endpoint surface

### New endpoints

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/.well-known/oauth-authorization-server` | OAuth 2.0 Authorization Server Metadata (RFC 8414) | None |
| GET | `/.well-known/oauth-protected-resource` | OAuth 2.0 Protected Resource Metadata (RFC 9728) | None |
| POST | `/oauth/register` | Dynamic Client Registration (RFC 7591) | None |
| GET | `/oauth/authorize` | Authorization endpoint — redirects to Heroku sign-in | Session cookie OR triggers sign-in |
| POST | `/oauth/token` | Token endpoint — code→access_token, refresh→access_token | Client credentials (basic auth) |
| POST | `/oauth/revoke` | Token revocation (RFC 7009) | Client credentials |

### Modified endpoints

| Endpoint | Change |
|---|---|
| `/mcp` | On `401`, response now includes `WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource"`. |
| `/me` | Adds "Connected applications" section above the existing bearer-token section. Bearer-token section becomes collapsed-by-default `<details>`. |
| `/oauth/callback` | Branches: if no DCR-client-bound flow, behaves as today (renders `/me` with bearer token). If part of a DCR-client authorization flow, redirects to client's `redirect_uri` with `code` parameter. |

### Unchanged endpoints

- `/oauth/start` (legacy sign-in flow for bearer path) — kept verbatim
- `/audit`, `/admin/*`, `/health` — no changes
- All Heroku OAuth machinery (`packages/http-server/src/oauth/heroku.ts`) — no changes; this is server-to-Heroku, totally separate from server-to-client OAuth

---

## Sequence diagrams

### A) Claude Desktop Custom Connector first-time connect

```
User              Claude Desktop          Our /mcp server         Heroku
 |                       |                       |                    |
 |--- Add connector ---->|                       |                    |
 | (URL only)            |                       |                    |
 |                       |--- GET /mcp --------->|                    |
 |                       |<-- 401 + WWW-Auth ----|                    |
 |                       |                       |                    |
 |                       |--- GET /.well-known/. |                    |
 |                       |    oauth-protected-   |                    |
 |                       |    resource --------->|                    |
 |                       |<-- {auth_server URL}--|                    |
 |                       |                       |                    |
 |                       |--- GET /.well-known/. |                    |
 |                       |    oauth-authorization|                    |
 |                       |    -server ---------->|                    |
 |                       |<-- {endpoints + DCR}--|                    |
 |                       |                       |                    |
 |                       |--- POST /oauth/       |                    |
 |                       |    register --------->|                    |
 |                       |<-- {client_id,        |                    |
 |                       |     client_secret}    |                    |
 |                       |                       |                    |
 |                       |--- Open browser to    |                    |
 |                       |    /oauth/authorize-->|                    |
 |                       |    ?client_id=...     |                    |
 |                       |    &code_challenge=.. |                    |
 |                       |    &redirect_uri=..   |                    |
 |                       |                       |                    |
 |                       |    [No session cookie — kick off Heroku sign-in]
 |                       |                       |--- Redirect to --->|
 |                       |                       |    Heroku OAuth    |
 |<------ User signs in at Heroku -------------------->|              |
 |                       |                       |<-- code ---|       |
 |                       |                       |                    |
 |                       |    [Heroku token exchange — existing Phase 4 code]
 |                       |                       |                    |
 |                       |    [Allowlist check]                       |
 |                       |    - In allowlist → skip consent           |
 |                       |    - Not in → show consent screen          |
 |                       |                                            |
 |                       |--- Redirect back to                        |
 |                       |    Claude Desktop with                     |
 |                       |    ?code=AUTHCODE----|                    |
 |                       |                       |                    |
 |                       |--- POST /oauth/token  |                    |
 |                       |    {code, verifier} ->|                    |
 |                       |                       |    [PKCE verify, code lookup, hmcp_ mint]
 |                       |<-- {access_token,     |                    |
 |                       |     refresh_token,    |                    |
 |                       |     expires_in: 3600} |                    |
 |                       |                       |                    |
 |                       |--- POST /mcp          |                    |
 |                       |    Auth: Bearer hmcp_ |                    |
 |                       |--------------------- >|                    |
 |                       |                       |  [middleware finds  |
 |                       |                       |   oauth_tokens row, |
 |                       |                       |   uses linked       |
 |                       |                       |   heroku_tokens row]|
 |                       |<-- MCP response ------|                    |
```

### B) Bearer-token (current Phase 4 behavior, unchanged)

```
User              Claude Code             Our /mcp server         Heroku
 |                       |                       |                    |
 |--- Browser to /me --->|                       |                    |
 |--- Signs in via Heroku (existing flow) --------->|                |
 |<-- /me with hmcp_... -|                       |                    |
 |                       |                       |                    |
 |--- claude mcp add ---->|                      |                    |
 |    --transport http   |                       |                    |
 |    --header "Auth: B  |                       |                    |
 |    hmcp_..." URL      |                       |                    |
 |                       |                       |                    |
 |                       |--- POST /mcp          |                    |
 |                       |    Auth: Bearer hmcp_ |                    |
 |                       |--------------------- >|                    |
 |                       |                       |  [middleware finds  |
 |                       |                       |   connection_tokens |
 |                       |                       |   row, uses linked  |
 |                       |                       |   heroku_tokens]    |
 |                       |<-- MCP response ------|                    |
```

Both paths converge at the middleware: lookup by `SHA-256(token)` against either `oauth_tokens` or `connection_tokens`, use the linked `heroku_tokens` row for the Heroku API call.

---

## Auth server metadata documents

### `/.well-known/oauth-authorization-server`

```json
{
  "issuer": "https://<server>",
  "authorization_endpoint": "https://<server>/oauth/authorize",
  "token_endpoint": "https://<server>/oauth/token",
  "registration_endpoint": "https://<server>/oauth/register",
  "revocation_endpoint": "https://<server>/oauth/revoke",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post"],
  "scopes_supported": [],
  "service_documentation": "https://github.com/baliles/herokumcp"
}
```

### `/.well-known/oauth-protected-resource`

```json
{
  "resource": "https://<server>/mcp",
  "authorization_servers": ["https://<server>"],
  "bearer_methods_supported": ["header"],
  "resource_documentation": "https://github.com/baliles/herokumcp"
}
```

Both documents are static (no per-request state). The `<server>` value comes from `HEROKUMCP_PUBLIC_URL` env var (new in 4.5; required for the OAuth flow to work because URLs must be absolute and externally-resolvable).

---

## Endpoint specifications

### `POST /oauth/register`

**Request body (RFC 7591):**
```json
{
  "client_name": "Claude Desktop",
  "redirect_uris": ["https://claude.ai/oauth-callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "client_secret_basic"
}
```

**Response (201 Created):**
```json
{
  "client_id": "<32 hex chars>",
  "client_secret": "<43 char base64url>",
  "client_secret_expires_at": 0,
  "client_id_issued_at": 1716835200,
  "client_name": "Claude Desktop",
  "redirect_uris": ["https://claude.ai/oauth-callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "client_secret_basic",
  "registration_client_uri": "https://<server>/oauth/register/<client_id>",
  "registration_access_token": "<opaque token>"
}
```

`client_secret_expires_at: 0` means never. We don't rotate secrets at this layer; revocation is the user's tool.

### `GET /oauth/authorize`

**Query parameters:**
- `response_type=code` (required, only "code" supported)
- `client_id=<from DCR>` (required)
- `redirect_uri=<must match registered>` (required)
- `code_challenge=<base64url(SHA256(verifier))>` (required, S256 only)
- `code_challenge_method=S256` (required)
- `state=<opaque>` (recommended, passed through)
- `scope=<ignored>` (optional, accepted for spec conformance)

**Behavior:**

1. Validate `client_id` exists in `oauth_clients`, not revoked.
2. Validate `redirect_uri` matches one registered for the client.
3. Validate `code_challenge` is base64url, length 43.
4. Check for existing valid session cookie. If user is signed in:
   - Check allowlist (D2). If allowed → skip consent, generate code, redirect.
   - If not allowed → render consent screen.
5. If no valid session: redirect to `/oauth/start` with `next` pointing back at the original `/oauth/authorize?...` URL (existing Phase 4 sign-in flow handles Heroku auth, returns to `next` on success).
6. On consent "Allow" or auto-allow: generate authorization code (32 hex chars), store `SHA-256(code)` in `oauth_authorizations`, redirect to `redirect_uri?code=...&state=...`.
7. On consent "Deny": redirect to `redirect_uri?error=access_denied&state=...`.

### `POST /oauth/token`

**Two grants supported.**

**Authorization code grant:**
```
POST /oauth/token
Authorization: Basic <base64(client_id:client_secret)>
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=<auth code>
&redirect_uri=<must match authorize>
&code_verifier=<PKCE verifier>
```

Validation:
1. Client credentials valid (constant-time compare against `client_secret_hash`).
2. Code exists in `oauth_authorizations`, not used, not expired.
3. `redirect_uri` matches stored value.
4. `SHA256(code_verifier) == code_challenge` (constant-time compare).
5. Mark code `used_at = now()`.
6. Generate `access_token = "hmcp_" + 32 random bytes base64url`. Generate `refresh_token = "hmcprt_" + 32 random bytes base64url`.
7. Insert into `oauth_tokens` with 1h access expiry, 90d refresh expiry.

**Response:**
```json
{
  "access_token": "hmcp_...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "hmcprt_...",
  "scope": ""
}
```

**Refresh token grant:**
```
POST /oauth/token
Authorization: Basic <base64(client_id:client_secret)>
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&refresh_token=<hmcprt_...>
```

Validation:
1. Client credentials valid.
2. Refresh token exists, not revoked, not expired.
3. Mark old access_token + refresh_token revoked.
4. Issue new access_token + new refresh_token (rotation).

Same response shape.

### `POST /oauth/revoke` (RFC 7009)

**Request:**
```
POST /oauth/revoke
Authorization: Basic <base64(client_id:client_secret)>
Content-Type: application/x-www-form-urlencoded

token=<access or refresh token>
token_type_hint=access_token  (optional)
```

**Response:** Always 200 OK (per RFC, even on unknown tokens).

Marks the matching row `revoked_at = now()`. Affects both the access_token and the linked refresh_token (or vice versa).

### Bearer middleware update

Current behavior: `SHA256(token)` → lookup in `connection_tokens` table.

New behavior:
1. `SHA256(token)` → lookup in `oauth_tokens` where `revoked_at IS NULL AND expires_at > now()`. If hit, use linked `user_id` and `heroku_tokens`.
2. If miss, fall back to `connection_tokens` (bearer path, unchanged).
3. If both miss, return `401` with `WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource"`.

The `WWW-Authenticate` header is critical — it's what lets Claude Desktop discover the auth server when it first hits a 401.

---

## Test plan

### Unit tests (new)

- `test/oauth-provider/dcr.test.ts` — POST `/oauth/register`, schema validation, client_id/secret generation, persistence
- `test/oauth-provider/authorize.test.ts` — query param validation, redirect_uri matching, PKCE storage, consent skip logic, redirect responses
- `test/oauth-provider/token-code.test.ts` — authorization_code grant, PKCE verification (positive + negative), code reuse rejection, expiry rejection, client cred validation
- `test/oauth-provider/token-refresh.test.ts` — refresh_token grant, rotation, revocation of old tokens, expiry
- `test/oauth-provider/revoke.test.ts` — revocation idempotency, both access and refresh
- `test/oauth-provider/metadata.test.ts` — both `.well-known` documents render with correct values from `HEROKUMCP_PUBLIC_URL`
- `test/oauth-provider/middleware-priority.test.ts` — OAuth tokens take priority over connection_tokens, both work

### Integration tests (new — gated behind env var like Phase 4 e2e tests)

- `test/integration/oauth-full-flow.integration.test.ts` — register → authorize → token → call /mcp → refresh → call /mcp again → revoke → 401

### Test budget

| Category | Phase 4 baseline | Phase 4.5 target |
|---|---|---|
| Unit tests | 634 total | ~720 total (+86) |
| Integration tests | 8 e2e | 10 e2e (+2 for OAuth flow) |

---

## Implementation order

Build in this order. Each step is independently testable.

### Step 1 — Storage layer
- Migration `0002_oauth.sql`
- `packages/http-server/src/db/repos/oauth-clients.ts`
- `packages/http-server/src/db/repos/oauth-authorizations.ts`
- `packages/http-server/src/db/repos/oauth-tokens.ts`
- Unit tests for each repo against fake-pool

### Step 2 — Metadata documents
- `packages/http-server/src/routes/wellknown.ts`
- Both `.well-known` endpoints rendering from config
- Unit tests verifying JSON shape and URL substitution
- Add `HEROKUMCP_PUBLIC_URL` to config (required env var)

### Step 3 — DCR endpoint
- `packages/http-server/src/oauth-provider/dcr.ts`
- `POST /oauth/register` route
- Unit tests for happy path + validation errors

### Step 4 — Authorize endpoint (no consent screen yet)
- `packages/http-server/src/oauth-provider/authorize.ts`
- Reuse `flow.ts` Heroku sign-in machinery via `next=` redirect
- Auto-allow ALL users initially (consent screen step 5 below)
- Unit tests: param validation, redirect_uri matching, code generation

### Step 5 — Consent screen
- `packages/http-server/src/views/consent.ts` (new view template)
- Allowlist check that gates consent screen
- POST handler for Allow / Deny buttons
- Unit tests: allowlist short-circuit, deny redirects with error

### Step 6 — Token endpoint
- `packages/http-server/src/oauth-provider/token.ts`
- `POST /oauth/token` handler with both grant types
- PKCE verification (constant-time)
- Client credential validation (constant-time)
- Token rotation on refresh
- Unit tests: positive cases, replay attacks, expired codes, expired refresh tokens, wrong PKCE

### Step 7 — Revoke endpoint
- `packages/http-server/src/oauth-provider/revoke.ts`
- `POST /oauth/revoke` handler
- Unit tests

### Step 8 — Middleware update
- Modify `packages/http-server/src/auth/middleware.ts`
- Try `oauth_tokens` first, fall back to `connection_tokens`
- Add `WWW-Authenticate` header on 401
- Unit tests: both token types work, header present on 401

### Step 9 — `/me` page UI update
- Modify `packages/http-server/src/views/pages.ts` and `routes/me.ts`
- Add "Connected applications" section
- List user's `oauth_clients` with revoke buttons
- Collapse bearer-token section under `<details>`
- Unit tests: section renders, revoke endpoint works

### Step 10 — Integration test
- `test/integration/oauth-full-flow.integration.test.ts`
- Walk register → authorize → token → /mcp → refresh → /mcp → revoke

### Step 11 — Documentation
- Update `packages/http-server/README.md` — Custom Connector path primary
- Update root `DEPLOYMENT.md` — env vars (add `HEROKUMCP_PUBLIC_URL`)
- New `OAUTH.md` design notes referencing this doc
- Add divergences entry for any deviations from this design discovered during build

### Step 12 — Smoke test against Claude Desktop
- Use production Heroku Button deploy or local with HTTPS tunnel (ngrok)
- Add custom connector in Claude Desktop, paste URL only
- Complete sign-in flow
- Verify token list, run a few tool calls
- Verify revoke from `/me` invalidates Claude Desktop's connection

### Step 13 — Tag
- Commit, tag `http-server-v0.2.0`, push
- Update notes/divergences.md with anything that came up

---

## Estimated size

| Step | LoC estimate | Tests added |
|---|---|---|
| 1 — Storage | ~600 | ~30 |
| 2 — Metadata | ~80 | ~6 |
| 3 — DCR | ~200 | ~10 |
| 4 — Authorize | ~350 | ~14 |
| 5 — Consent screen | ~250 | ~6 |
| 6 — Token | ~500 | ~20 |
| 7 — Revoke | ~100 | ~6 |
| 8 — Middleware | ~80 | ~4 |
| 9 — /me UI | ~200 | ~6 |
| 10 — Integration | ~300 | ~2 e2e |
| 11 — Docs | ~400 | 0 |
| 12 — Smoke test | manual | 0 |
| **Total** | **~3060 LoC** | **~104 unit + 2 e2e** |

About 40% of Phase 4's size. Plausible.

---

## Risks and unknowns

**R1: HTTPS required for Claude Desktop testing.** OAuth redirect URIs from claude.ai will be `https://claude.ai/...`. Claude Desktop won't accept HTTP redirects from `localhost:3000` for the auth flow (it'll work for Claude Code with manual bearer, but not for the OAuth path). Smoke testing needs ngrok or actual Heroku deploy. Plan: do most testing locally with curl simulating Claude's role, then final smoke test against a deployed instance.

**R2: Dynamic Client Registration may surprise users.** Anyone who can reach `/oauth/register` can create a client. That's by design (D1) but could be surprising in a private team deployment. Mitigation: clients only matter when paired with an allowlisted user, so the allowlist still gates access. Worth a note in DEPLOYMENT.md.

**R3: Refresh token rotation interacting with concurrent requests.** If Claude Desktop makes two requests near-simultaneously and both trigger a refresh, one wins and the other gets a now-revoked token. Standard OAuth gotcha; clients are supposed to serialize. Mitigation: `oauth_tokens.revoked_at` is set in the same transaction that issues the new token, and the middleware returns 401 (not 500) when the old token is presented — Claude Desktop will then refresh again and retry. Worth a comment in the code explaining the race.

**R4: MCP spec is moving.** The 2025-06-18 auth spec deprecates some of the 2025-03-26 behavior. We target whichever Claude Desktop currently implements at smoke-test time. Since both are supported (per Anthropic docs as of writing), we implement the 2025-06-18 path. If a future spec breaks us, we patch.

**R5: The error message we improved in fetchAccount only fires for Heroku token failures.** Phase 4.5's new endpoints have their own errors (PKCE failure, expired code, client mismatch). Each gets clear `error` + `error_description` fields per RFC 6749. No room to be lazy here — the OAuth client sees these messages and the user pays for it.

---

## What this does NOT solve

- Claude API's MCP connector (server-to-server use case) — separate from Claude Desktop, uses a different flow. If we want to support that too, it's a future phase.
- Token-bound DPoP (proof-of-possession) — MCP spec mentions it as optional. We're issuing bearer tokens for now. Could add later.
- Per-tool consent — consent is at the connection level, not per-tool. The spec doesn't require finer granularity.
- Multi-tenant operator dashboards. Each Heroku Button deploy is single-operator. If we ever want operator-of-operators (a "herokumcp cloud"), that's a different product.

---

**Approved by:** _to be filled by David before implementation handoff_
**Implementation handoff target:** Claude Code IDE
**Estimated duration:** 2-3 days of focused work

