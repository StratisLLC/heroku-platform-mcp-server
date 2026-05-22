# Heroku MCP — Authentication & Authorization

> Detailed design for how users authenticate to the deployed MCP, how the MCP authenticates to Heroku on their behalf, how secrets are stored, and how sessions and connection tokens work.
>
> Read `DEPLOYMENT.md` first for the operator's-eye view. This document is for implementers and security reviewers.

## Identity model

There are three principals to keep distinct:

1. **End user** — a human with a Heroku account who wants to use the MCP. Identified by their Heroku account `id` (UUID). Always acts with their own Heroku permissions; no service-account proxying.
2. **Operator** — the human who deployed the MCP. Identified the same way as an end user (also has a Heroku account). The operator gets one extra capability: they administer the deployment via `heroku run` and `heroku config:set`. The MCP itself does not have an "admin user" concept; admin operations are CLI-driven against the deployed app.
3. **The MCP app itself** — a Heroku app with an OAuth client_id and client_secret. Not a principal in any user-facing sense; it's the OAuth client that mediates between end users and Heroku.

The MCP **never** holds long-lived superuser credentials. The most powerful credential it stores is a refresh token for one end user with scope no broader than what that user consented to.

## The two-credential model

When an end user is signed in, the MCP holds two distinct credentials for them:

**Credential A — Heroku OAuth tokens (the API credential).**
- Issued by Heroku's OAuth provider when the user signs in.
- Scope: `write-protected` by default (configurable via `MCP_OAUTH_SCOPE`).
- Lifetime: access token ~8 hours, refresh token long-lived (until revoked).
- Stored encrypted at rest in Postgres (envelope encryption with `MCP_ENCRYPTION_KEY`).
- Used by the MCP to call `api.heroku.com` on the user's behalf.
- Revocable by: the user from Heroku's OAuth authorizations dashboard, the operator via admin script, or automatic on detected misuse.

**Credential B — MCP connection token (the protocol credential).**
- Issued by the MCP itself when the user completes sign-in.
- Format: opaque random string, 256 bits of entropy, prefixed `hmcp_` for visual identification.
- Lifetime: configurable, default 90 days. Refreshed on use (sliding window).
- Stored hashed (SHA-256) in Postgres, alongside the user_id it maps to. The plaintext is shown to the user once at issuance and never again.
- Used by MCP-aware clients (Claude Desktop, Claude Code) as a `Authorization: Bearer hmcp_...` header on every MCP request.
- Revocable by: the user from their own `/setup` page, the operator from the admin CLI, automatic on TTL expiry or after N (default 10) consecutive 401 responses on the underlying Heroku call.

Critical: **Credential B is not Credential A.** Possession of an MCP connection token does not directly grant access to the user's Heroku account — it grants access to the MCP, which then has a separately-revocable Heroku OAuth token. If a user's Claude config leaks, they revoke the connection token. If their Heroku OAuth grant leaks (extremely unlikely — we never expose the access token over the wire after issuance), they revoke the grant from Heroku's dashboard. The two-credential model means leaks are containable.

## OAuth flow — sign-in

Standard OAuth 2.0 authorization-code flow with PKCE. The MCP is the OAuth client; `id.heroku.com` is the authorization server.

### Step 1 — Initiate

User clicks "Sign in with Heroku" on `/setup` or `/auth/heroku/login`. The MCP:

1. Generates a random `state` (256 bits) and `code_verifier` (per PKCE RFC 7636). Stores both in the user's pre-sign-in session cookie.
2. Computes `code_challenge = base64url(sha256(code_verifier))`.
3. Redirects the user to:
   ```
   https://id.heroku.com/oauth/authorize
     ?client_id={HEROKU_OAUTH_CLIENT_ID}
     &response_type=code
     &scope={MCP_OAUTH_SCOPE}
     &state={state}
     &code_challenge={code_challenge}
     &code_challenge_method=S256
   ```

### Step 2 — User consent

User authenticates with Heroku (if not already), reviews the consent screen, clicks "Authorize". Heroku redirects back to:

```
https://{app}.herokuapp.com/auth/heroku/callback?code={auth_code}&state={state}
```

### Step 3 — Callback

The MCP:

1. Validates `state` matches what was stored in the pre-sign-in session. If not, abort with `invalid_state` error and clear the session.
2. POSTs to `https://id.heroku.com/oauth/token` with:
   ```
   grant_type=authorization_code
   code={auth_code}
   client_secret={HEROKU_OAUTH_CLIENT_SECRET}
   code_verifier={code_verifier from session}
   ```
3. Receives `{access_token, refresh_token, expires_in, token_type}`.
4. Calls `GET /account` with the new access token to learn the user's `id`, `email`, `name`.
5. **Authorization check** (see "Access control" below). If the user is not allowed, abort and show an explanatory page.
6. Encrypts the access token and refresh token (envelope encryption, see "Token storage" below) and upserts them into the `users` table keyed by Heroku `id`.
7. Mints an MCP connection token (256-bit random, prefixed `hmcp_`). Stores a SHA-256 hash plus `(user_id, created_at, expires_at, label)`.
8. Mints a session cookie (the user's web session, separate from Credential B). Redirects to `/setup` with the connection token in a one-time-display flash message.
9. The `/setup` page shows the connection token prominently with a "copy to clipboard" button and instructions for configuring Claude. The plaintext is never stored anywhere accessible to the operator or the user after this page is closed.

### Step 4 — Token refresh

When an MCP tool call needs to talk to Heroku, the MCP:

1. Looks up the user's stored access token. Decrypts it.
2. If it's within 60 seconds of expiry or has been rejected by Heroku with 401, refreshes:
   ```
   POST https://id.heroku.com/oauth/token
   grant_type=refresh_token
   refresh_token={decrypted refresh token}
   client_secret={HEROKU_OAUTH_CLIENT_SECRET}
   ```
2. Stores the new tokens (encrypted) and uses the new access token.
3. If refresh itself returns 401 (the user revoked the grant from Heroku's side, or the OAuth client secret was rotated, or the user's Heroku account is suspended), marks the user as `reauth_required`. The next MCP tool call returns a typed error that the host (Claude) surfaces, prompting the user to revisit `/setup` and sign in again.

Refresh is single-flight per user_id — a mutex prevents two concurrent tool calls from both triggering refreshes and one of them getting a stale token.

## Scope choice

Default scope: `write-protected`.

This scope allows the MCP to:
- Read all of the user's app, team, add-on, pipeline, space data
- Read protected resources (config var values, release output, etc.)
- Modify all of the above (scale, deploy, change config, etc.)

This scope does NOT allow:
- Deleting the user's Heroku account
- Reading/modifying other users' resources
- Anything outside the apps/teams/add-ons surface

Operators who want a more restricted MCP can set `MCP_OAUTH_SCOPE` to:
- `read-protected` — read-only, including config var values
- `read` — read-only, no protected resources (config var values hidden)
- `identity` — sign-in only, no API calls work (almost useless; provided for completeness)

Changing the scope env var doesn't affect existing user authorizations. They keep the scope they originally consented to. To force a re-consent, the operator runs the admin tool's `force-reauth-all` command (admin runbook in DEPLOYMENT.md).

Operators who want broader scope can set `MCP_OAUTH_SCOPE=global`. This is equivalent to a personal API token in power and is **not recommended**. The MCP design intentionally excludes account-deletion tools (gated behind `ALLOW_ACCOUNT_DELETION=true` separately) so even `global` scope users can't accidentally delete their account through the MCP — but other powerful operations become available.

## Access control

Two access lists, both consulted on every sign-in attempt:

### `MCP_ALLOWED_EMAILS`

Comma-separated list of email addresses. The user's `email` (from `GET /account`) must appear in the list. Matching is case-insensitive on the local part and case-insensitive on the domain.

Special value `*` means "allow any email that authenticates" — useful for genuinely public deployments where Heroku OAuth is the only access gate. Not recommended for non-public use.

### `MCP_ALLOWED_TEAMS`

Comma-separated list of Heroku team names. On sign-in, the MCP calls `GET /teams` with the user's new access token. If the user is a member of any team in the list, access is granted regardless of email.

Useful for teams that don't want to maintain a per-email list. Caveat: requires the OAuth scope to be at least `read` (the default `write-protected` includes this); users who consented to a narrower scope won't be authorizable via team membership.

### Evaluation order

1. If `MCP_ALLOWED_EMAILS` contains `*` → allow.
2. If the user's email is in `MCP_ALLOWED_EMAILS` → allow.
3. If `MCP_ALLOWED_TEAMS` is set and the user is a member of any → allow.
4. Otherwise → deny, show a "your email is not authorized" page with the operator's contact email (from `MCP_OPERATOR_CONTACT` env var if set).

### Re-evaluation on every request

The access lists are re-evaluated on every tool call, not just at sign-in. If the operator removes a user from `MCP_ALLOWED_EMAILS`, the user's next tool call fails with `forbidden`. This prevents the "removed user keeps working until their session expires" failure mode.

## Token storage — envelope encryption

The threat model is "Postgres database is compromised, MCP_ENCRYPTION_KEY config var is not." This is realistic — database backups, accidental log exports, and SQL injection bugs are common; config var compromise is rarer because Heroku scopes config var access tightly.

### Schema

```sql
CREATE TABLE users (
  id                UUID PRIMARY KEY,                -- Heroku account id
  email             TEXT NOT NULL,
  name              TEXT,
  -- Encrypted OAuth tokens. NULL until first sign-in.
  enc_access_token  BYTEA,
  enc_refresh_token BYTEA,
  token_expires_at  TIMESTAMPTZ,
  scope             TEXT NOT NULL,
  reauth_required   BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE connection_tokens (
  id           UUID PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   BYTEA NOT NULL UNIQUE,                -- SHA-256(token plaintext)
  label        TEXT,                                 -- user-set, e.g. "Laptop Claude Desktop"
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX ON connection_tokens (user_id) WHERE revoked_at IS NULL;
CREATE INDEX ON connection_tokens (token_hash) WHERE revoked_at IS NULL;

CREATE TABLE web_sessions (
  id          UUID PRIMARY KEY,
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,  -- NULL during pre-sign-in
  data        JSONB NOT NULL DEFAULT '{}',                  -- PKCE verifier, state, redirect target
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id             BIGSERIAL PRIMARY KEY,
  ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id        UUID REFERENCES users(id),
  tool           TEXT NOT NULL,
  method         TEXT NOT NULL,
  target         TEXT,
  status         INTEGER,
  request_id     TEXT,
  duration_ms    INTEGER,
  error_kind     TEXT,
  error_message  TEXT
);
CREATE INDEX ON audit_log (user_id, ts DESC);
CREATE INDEX ON audit_log (ts DESC);
```

### Encryption

Per-record envelope encryption:

1. A per-record Data Encryption Key (DEK) is generated when a token is first stored: 32 random bytes.
2. The token plaintext is encrypted with AES-256-GCM using the DEK. The IV is 12 random bytes prepended to the ciphertext. The auth tag is appended.
3. The DEK is then encrypted with AES-256-GCM using a Key Encryption Key (KEK) derived from `MCP_ENCRYPTION_KEY` via HKDF-SHA-256 with a per-record salt. The wrapped DEK, IV, and tag are stored alongside the encrypted token.
4. The on-disk format for `enc_access_token` is:
   ```
   [version:1B] [salt:16B] [wrapped_dek_iv:12B] [wrapped_dek:48B] [token_iv:12B] [token_ciphertext+tag:variable]
   ```

Why envelope encryption rather than just encrypting the token directly with the KEK?
- Allows key rotation: re-wrap the DEK with a new KEK without decrypting and re-encrypting the token itself.
- Defense in depth: if the KEK is briefly exposed (e.g. logged accidentally), the attacker still needs each per-record salt to derive the actual encryption key.
- Standard pattern; same approach AWS KMS, GCP KMS, and Vault use internally.

### KEK rotation

Rotating `MCP_ENCRYPTION_KEY` is a four-step operation:

1. Read every encrypted record, decrypt the DEK with the old KEK.
2. Re-encrypt the DEK with the new KEK (same DEK, new wrap).
3. Atomically write the new wrapped DEK back.
4. Update the config var.

The admin script `rekey` does this with a transaction per record. The token plaintext is never written to disk or memory beyond the duration of the unwrap-rewrap. Step 1-3 takes about 1ms per user; even with 10,000 users, rotation completes in seconds. Operator runbook details in `DEPLOYMENT.md`.

### Connection token storage

Connection tokens are stored as SHA-256 hashes, not encrypted. Two reasons:
- We only ever need to compare a presented token to known hashes, never recover the original.
- Hashing means the database compromise reveals nothing usable (an attacker can't even confirm whether a guessed token is valid without trying it against the API, which is rate-limited).

The cost: if a user loses their token, the operator can't recover it — they have to issue a new one. This is the correct trade-off.

## MCP transport authentication

The MCP server uses Streamable HTTP transport per the MCP spec.

### Authentication

Every MCP request must carry `Authorization: Bearer hmcp_...` in the headers. The MCP server:

1. Extracts the bearer token. If missing, returns 401 with `{ "error": "missing_credentials" }`.
2. Hashes it (SHA-256) and looks up in `connection_tokens` where `revoked_at IS NULL AND expires_at > now()`.
3. If not found, returns 401 `{ "error": "invalid_credentials" }`.
4. If found, updates `last_used_at`, joins to `users`, checks `reauth_required` and the access control lists.
5. If everything passes, attaches the user context to the request and dispatches to the MCP handler.

### Session lifecycle

The MCP spec's `Mcp-Session-Id` header is used for protocol-level session tracking (initialize → tools/list → tools/call sequences). The MCP server stores active sessions in memory keyed by `(connection_token_hash, mcp_session_id)`. Sessions evict on disconnect or after 60min of inactivity.

The same connection token can have multiple concurrent MCP sessions (e.g. user has Claude Desktop and Claude Code open simultaneously). Each session gets its own MCP capability snapshot but they share the user's underlying Heroku OAuth tokens — no point in re-probing for the same user twice in a short window.

## The Partner MCP — same model with one twist

For `heroku-partner-mcp-deploy`, the deployed user is the add-on partner's engineer, not an end customer. The auth model is the same — sign in with Heroku, get an MCP connection token — but the Heroku OAuth flow uses the Partner's product-specific OAuth client, not a freshly-created one per deployment.

Specifically:
- The partner already has an OAuth client_id and client_secret from the Add-on Partner Portal (used to mediate the grant-code exchange when an add-on is provisioned).
- That same client_id/client_secret is supplied as `HEROKU_OAUTH_CLIENT_ID` / `HEROKU_OAUTH_CLIENT_SECRET` to the deploy.
- When a partner engineer signs in to the MCP, they go through the same Heroku OAuth flow but using the partner's existing client. Their access token is scoped to their personal Heroku permissions on their own apps (this is incidental — the MCP isn't *acting as* the partner here, just using Heroku OAuth for sign-in identity).

The interesting part of the Partner MCP is the **per-resource OAuth tokens** for installed add-ons. These are the tokens issued via grant-code exchange when a customer installs the add-on, and they're not user-OAuth tokens — they're resource-scoped tokens, one per provisioned add-on. The Partner MCP stores them in a separate `addon_resources` table:

```sql
CREATE TABLE addon_resources (
  resource_uuid     UUID PRIMARY KEY,
  app_id            UUID,
  app_name          TEXT,
  enc_access_token  BYTEA NOT NULL,
  enc_refresh_token BYTEA NOT NULL,
  token_expires_at  TIMESTAMPTZ,
  plan              TEXT,
  region            TEXT,
  state             TEXT NOT NULL,                       -- provisioned, deprovisioned
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

These are populated by the `grant_exchange` tool (called by the partner's webhook handler when Heroku sends a provision request) and consumed by every Partner-MCP tool that operates on an add-on resource. Access control on the Partner MCP is "any authorized partner engineer can query any of the partner's add-on resources" — there's no per-customer authorization, because all data is the partner's own.

## What gets logged, what doesn't

The audit log records:
- User email
- Tool name
- HTTP method and resource type (e.g. `DELETE`, `app`)
- Target resource name (the app/team/addon name, since these are identifying but not sensitive)
- Status code from Heroku
- Heroku `Request-Id` (essential for support tickets)
- Duration in milliseconds
- Error kind and message (sanitized)

The audit log NEVER contains:
- Access tokens, refresh tokens, connection tokens (even hashed)
- Request bodies (especially config var values)
- Response bodies
- The `MCP_ENCRYPTION_KEY` or any other secret
- Cookie values

The stderr log (visible via `heroku logs`) follows the same redaction rules. Every log line passes through the same redaction function from `@heroku-mcp/core/redact`.

## Failure modes worth thinking about

**Heroku OAuth provider down.** New sign-ins fail; existing sessions continue working until their access tokens expire (~8h). When `id.heroku.com` returns 5xx, the MCP shows a maintenance page with retry guidance.

**Heroku Postgres down.** Everything breaks — sessions, audit log, token lookup all hit the database. The MCP returns 503 with retry-after. Hosts (Claude) back off and retry.

**OAuth client secret rotated externally.** Token refresh starts failing with 401. The MCP marks affected users as `reauth_required` and surfaces a clear error on the next tool call.

**`MCP_ENCRYPTION_KEY` accidentally cleared.** The MCP detects this on startup (existing encrypted records can't be decrypted with the missing key) and refuses to start. Recovery requires either restoring the original key or running the `clear-all-tokens` admin script and forcing all users to re-authenticate.

**Database compromise + KEK compromise simultaneously.** Worst case: attacker can decrypt all stored Heroku tokens. Their scope is `write-protected` on each user's account — bad, but not full-account-takeover. Mitigation: every user gets notified to revoke their authorization at Heroku's OAuth dashboard, which immediately invalidates the leaked tokens regardless of what the attacker does. The MCP includes a "panic" admin command that emails every user with re-auth instructions.

**Database compromise alone (most likely scenario).** Attacker has hashed connection tokens (useless), encrypted Heroku tokens (unreadable without KEK), audit log (no secrets), user emails (low-value PII). This is the threat envelope encryption is designed for.

**A user's Claude config syncs to a personal device.** The connection token is now on a device the user might not control as tightly. Mitigation: connection tokens have labels ("Laptop", "Phone", etc.) and `/setup` shows recent activity per token. Users notice unexpected activity and revoke.

**Operator's Heroku account is compromised.** Game over for that deployment. The attacker can read `MCP_ENCRYPTION_KEY` from config, dump the Postgres, and decrypt all stored tokens. This is the failure mode that's fundamental to "you operate the MCP" — we can't protect against compromise of the operator's own Heroku account, but we can make it the only way in. Mitigation guidance for operators: 2FA on the Heroku account, principle of least privilege on `heroku access`, monitoring for unusual `heroku run` or `heroku config:get` activity.
