# OAuth in herokumcp

This server speaks OAuth in two distinct directions. They look similar from
a distance but solve completely different problems. Conflating them is the
single most common source of confusion when reading the codebase.

## The two directions

### Direction A: server-to-Heroku (Phase 4)

The MCP server is an *OAuth client* of Heroku.

- The operator registers an OAuth client with Heroku once at deploy time
  (`heroku clients:create …`).
- Each MCP end user signs in via `/sign-in` → Heroku's authorize endpoint
  → `/oauth/callback`. The server exchanges the code for a Heroku
  access/refresh token pair and stores them encrypted under the master
  KEK in the `heroku_tokens` table.
- The MCP later uses those tokens to call `api.heroku.com/*` on the user's
  behalf when a tool fires.

This is implemented in [`packages/http-server/src/oauth/heroku.ts`](packages/http-server/src/oauth/heroku.ts)
and [`packages/http-server/src/oauth/flow.ts`](packages/http-server/src/oauth/flow.ts).
It has not changed in Phase 4.5.

### Direction B: client-to-server (Phase 4.5)

The MCP server is itself an *OAuth authorization server*. Claude Desktop
(or any MCP-aware client implementing the MCP 2025-06-18 auth spec) is
its client.

- A fresh client registers via Dynamic Client Registration
  ([RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591)) at
  `POST /oauth/register` and receives a `client_id` + `client_secret`.
- The client opens a browser to `GET /oauth/authorize?...` (PKCE S256).
  If the user has no active web session, we redirect through Direction A's
  `/sign-in` flow to authenticate them. Once authenticated and (auto- or
  manually) consenting, we redirect back to the client's `redirect_uri`
  with a one-time `code`.
- The client posts the code + PKCE verifier to `POST /oauth/token` and
  receives an `access_token` (`hmcp_…`, 1 h TTL) and `refresh_token`
  (`hmcprt_…`, 90 d TTL, rotated on each use).
- The client presents `Authorization: Bearer hmcp_…` to `/mcp`. The
  server's bearer middleware looks the hash up in `oauth_tokens` first,
  falls back to `connection_tokens` (Phase 4 bearer path).
- On 401, the middleware emits a
  `WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource"`
  header so clients can discover the auth server.

This is implemented in [`packages/http-server/src/oauth-provider/`](packages/http-server/src/oauth-provider/)
and [`packages/http-server/src/routes/wellknown.ts`](packages/http-server/src/routes/wellknown.ts).
Migration `0002_oauth.sql` adds the three backing tables.

## How they compose

Direction B's `/oauth/authorize` cannot complete without Direction A having
seeded the user's `heroku_tokens` row — so when no session cookie is
present, the authorize handler 302s to `/sign-in?next=<original-authorize-url>`,
which runs the Heroku sign-in, then `/oauth/callback` honors the `next`
parameter to bring the user back to `/oauth/authorize`. This is why a fresh
Claude Desktop connection prompts the user to sign in with Heroku once, but
on subsequent connections (within the 30-day web-session TTL) it doesn't.

```
Claude Desktop          our /mcp server          Heroku id.heroku.com
        |                       |                          |
        | -- POST /mcp -------- |                          |
        |                       | --- 401 + WWW-Auth ----- |
        | <- 401 -------------- |                          |
        |                                                  |
        | -- GET .well-known/oauth-protected-resource ---- |
        | -- GET .well-known/oauth-authorization-server -- |
        | -- POST /oauth/register ----------------------   |
        |                                                  |
        | -- browser GET /oauth/authorize ?... ----------  |
        |                       |   no session — 302 to    |
        |                       |   /sign-in?next=...      |
        |                       |   ----- 302 to Heroku -> |
        | <-- user signs in at Heroku --------------------|
        |                       | <- callback w/ code ----|
        |                       |                          |
        |                       |   exchange code,         |
        |                       |   persist heroku_tokens, |
        |                       |   redirect back to       |
        |                       |   /oauth/authorize?...   |
        |                       |                          |
        |                       |   consent (or auto-allow)|
        |                       |   mint code, redirect    |
        |                       |   to claude.ai/cb?code=  |
        |                                                  |
        | -- POST /oauth/token ---------------------       |
        | <-- access_token + refresh_token ----------------|
        |                                                  |
        | -- POST /mcp w/ Bearer hmcp_… ----- 200 OK ------|
```

## Token shapes

| Kind | Prefix | Length after prefix | TTL | Refresh? | Storage |
|---|---|---|---|---|---|
| Bearer (Phase 4 manual path) | `hmcp_` | 43 base64url | never | n/a | `connection_tokens.token_hash` |
| OAuth access (Phase 4.5) | `hmcp_` | 43 base64url | 1 hour | yes | `oauth_tokens.access_token_hash` |
| OAuth refresh (Phase 4.5) | `hmcprt_` | 43 base64url | 90 days, rotated | n/a | `oauth_tokens.refresh_token_hash` |

Same `hmcp_` prefix for both access flavors is intentional: the middleware
tries `oauth_tokens` first, falls back to `connection_tokens`, and a single
header shape works for both. The distinct `hmcprt_` prefix exists so a log
scrape can tell at a glance which side of the pair was leaked.

All three are 256 bits of entropy; all three are stored as SHA-256 bytea,
never plaintext.

## Consent (D2)

After Heroku authentication completes, the user's identity is evaluated
against `MCP_ALLOWED_EMAILS` and `MCP_ALLOWED_TEAMS`:

- **Listed** → consent is *skipped*, the code is issued immediately. The
  operator has already pre-authorized this user; clicking *Allow* every
  time would be UX friction with no security benefit.
- **Not listed** → the consent screen renders ("X wants to access your
  Heroku account through this MCP, signed in as you@example.com.
  [Allow] [Deny]"). Required for MCP-spec compliance and security
  hygiene on open deployments.

## Dynamic Client Registration is open (D1)

`POST /oauth/register` accepts any well-formed request. The actual security
boundary is the user allowlist at authorize time — a DCR client with no
authorizing user behind it gets nothing useful.

Operators worried about an attacker registering 10 000 clients to fill the
table can wrap a rate limiter in front of `/oauth/register` at the
edge/CDN; the spec does not require us to gate registration.

## Concurrent refresh rotation

`/oauth/token` with `grant_type=refresh_token` revokes the presented refresh
token in the same DB statement that mints the new one. If Claude Desktop
issues two near-simultaneous /mcp calls and both notice the access token
has just expired, one wins the refresh and the other gets a now-revoked
token. The middleware returns 401 (not 500) in that case, and Claude
Desktop's expected behavior is to refresh again and retry. The race window
is the duration of a single DB UPDATE — usually <10 ms.

## What we deliberately don't do

- **DPoP / proof-of-possession tokens.** The MCP spec lists it as optional.
  We issue plain bearer tokens. Possible future phase.
- **Per-tool consent.** Consent is at the connection level, not per-tool.
  The spec doesn't require finer granularity.
- **`scope` enforcement.** We accept the `scope` parameter on
  `/oauth/authorize` for spec conformance, store it on the authorization
  row, but don't gate anything on it — every OAuth-issued token can call
  every tool the user's Heroku credentials allow. The user-level Heroku
  OAuth scope already gates what the resulting `api.heroku.com` calls can
  do.
- **Rotating client secrets.** `client_secret_expires_at: 0` (never). To
  invalidate a leaked secret, revoke the client from `/me`.
