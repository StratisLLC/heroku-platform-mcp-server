# `@heroku-mcp/http-server`

Hosted Streamable-HTTP MCP server for the Heroku Platform API.

Per-user OAuth sign-in. Encrypted Postgres token store. Full audit log. Admin UI.
Wraps the same 240 tools that the stdio binary
(`@heroku-mcp/platform`'s `herokumcp-platform` command) exposes.

Two ways to authenticate an MCP client:

1. **OAuth 2.1 Custom Connector** (recommended for Claude Desktop) — the
   server is a full OAuth 2.1 authorization server with Dynamic Client
   Registration. Claude Desktop's *Settings → Connectors → Add custom
   connector* dialog handles everything once you paste your `/mcp` URL.
2. **Bearer token** (Claude Code, MCP Inspector, curl, scripts) — sign in on
   `/me` and copy a long-lived `hmcp_…` token to paste into a custom
   `Authorization: Bearer` header.

Both paths coexist for the same user; see [`/me`](#me-page) for management.

## Why hosted mode

The stdio binary is the right answer for one developer on one machine: their
Heroku token lives in the OS keychain, the MCP runs as a subprocess of Claude
Desktop. For a team that wants Claude to manage shared Heroku resources, the
hosted shape gives you:

- A single deployment your teammates point Claude at.
- Heroku OAuth as the sign-in mechanism — no shared API tokens.
- One audit log of every tool call across every teammate.
- Revocable per-device connection tokens.

Both modes coexist; you can use either or both, depending on the audience.

## Quick start (local)

```bash
# 1. Run Postgres (or use Heroku Postgres / any other Postgres ≥ 13).
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16-alpine

# 2. Register a Heroku OAuth client targeting your local URL.
heroku clients:create "My MCP (local)" http://localhost:3000/oauth/callback

# 3. Set env vars and start.
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
export HEROKUMCP_MASTER_KEY=$(openssl rand -base64 32)
export HEROKUMCP_OAUTH_CLIENT_ID=<id from step 2>
export HEROKUMCP_OAUTH_CLIENT_SECRET=<secret from step 2>
export HEROKUMCP_ADMIN_CONTACT=admin@example.com
export HEROKUMCP_PUBLIC_URL=http://localhost:3000
export MCP_ADMIN_EMAILS=$(your-heroku-email)

pnpm --filter @heroku-mcp/http-server start
```

Visit <http://localhost:3000>, click **Sign in with Heroku**, complete the
OAuth round-trip, then either:

- (Recommended for Claude Desktop) Open *Claude Desktop → Settings →
  Connectors → Add custom connector* and paste `http://localhost:3000/mcp`.
  Click *Connect*; Claude Desktop handles the OAuth round-trip from there.
- (Claude Code etc.) Copy the freshly-minted `hmcp_…` token from `/me`'s
  *Advanced: bearer token* section.

## Required env vars

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string. |
| `HEROKUMCP_MASTER_KEY` | 32-byte base64-encoded AES-256 KEK. Generate with `openssl rand -base64 32`. **Losing this makes every stored token unreadable**. |
| `HEROKUMCP_OAUTH_CLIENT_ID` | The OAuth client `id` from `heroku clients:create`. Used to sign your users into *Heroku*. |
| `HEROKUMCP_OAUTH_CLIENT_SECRET` | The corresponding `secret`. |
| `HEROKUMCP_ADMIN_CONTACT` | Email/URL shown on access-denied pages. |
| `HEROKUMCP_PUBLIC_URL` | Externally-resolvable base URL (e.g. `https://herokumcp.example.com`). Required for the OAuth 2.1 Custom Connector flow — the `.well-known/oauth-*` metadata documents and the `WWW-Authenticate` header on 401 both reference it. No default, must be set. |

## Optional env vars

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port. |
| `HEROKUMCP_OAUTH_SCOPE` | `write-protected` | Heroku OAuth scope. |
| `MCP_ALLOWED_EMAILS` | (unset = anyone) | Comma-separated allowlist. Users in this list also skip the OAuth consent screen (D2). |
| `MCP_ALLOWED_TEAMS` | (unset) | Comma-separated Heroku team allowlist. Members also skip the OAuth consent screen. |
| `MCP_ADMIN_EMAILS` | (unset) | Comma-separated admin allowlist (gates /admin/*). |
| `HEROKUMCP_AUDIT_RETENTION_DAYS` | (unset = forever) | Daily cron prunes older audit rows. |
| `HEROKUMCP_LOG_LEVEL` | `info` | One of `debug`, `info`, `warn`, `error`. |
| `HEROKUMCP_DB_SSL` | `require` | `require` / `no-verify` / `off`. |

## Connecting clients

### Claude Desktop (OAuth Custom Connector — recommended)

1. *Settings → Connectors → Add custom connector*.
2. Paste your `/mcp` URL (e.g. `https://your-server.example/mcp`).
3. Click *Connect*. Claude Desktop will open a browser tab, walk the OAuth
   2.1 flow (Dynamic Client Registration → Heroku sign-in → consent or
   auto-allow → code exchange), and store the resulting access/refresh
   token pair internally.
4. Verify the connection on `/me` — it appears under **Connected
   applications**. Revoke from there at any time.

Behind the scenes the server implements:

| Endpoint | RFC | Purpose |
|---|---|---|
| `GET /.well-known/oauth-authorization-server` | RFC 8414 | Discovery |
| `GET /.well-known/oauth-protected-resource` | RFC 9728 | `/mcp` → AS pointer |
| `POST /oauth/register` | RFC 7591 | Dynamic Client Registration |
| `GET /oauth/authorize` | RFC 6749 + PKCE S256 | Auth code grant |
| `POST /oauth/token` | RFC 6749 | code / refresh_token grants |
| `POST /oauth/revoke` | RFC 7009 | Token revocation |

Access tokens are `hmcp_…` (1 h TTL). Refresh tokens are `hmcprt_…` (90 d
TTL, rotated on each use).

### Claude Code / MCP Inspector / curl (bearer)

```bash
claude mcp add --transport http \
  --header "Authorization: Bearer hmcp_..." \
  heroku-platform https://your-server.example/mcp
```

Or paste into `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) for an older Claude Desktop that doesn't have Custom Connector
support yet:

```json
{
  "mcpServers": {
    "heroku-platform": {
      "url": "https://your-server.example/mcp",
      "headers": {
        "Authorization": "Bearer hmcp_..."
      }
    }
  }
}
```

The `/me` page's *Advanced: bearer token* section renders a ready-to-paste
version with your token already embedded.

## `/me` page

After sign-in, `/me` shows:

- **Connected applications** (primary) — OAuth-DCR clients linked to you,
  with Connected/Last-active timestamps and per-client *Revoke* buttons.
- **Advanced: bearer token** (collapsed) — your long-lived `hmcp_…` tokens
  for non-OAuth clients, plus a *Revoke all bearer tokens* button.

## Admin UI

If your email is in `MCP_ADMIN_EMAILS`, additional pages appear in the nav:

- `/admin/users` — every signed-in user, with "revoke all tokens" actions.
- `/admin/tokens` — every connection token, including revoked.
- `/admin/audit` — cross-user audit log with filters + CSV export.
- `/admin/status` — DB reachability, Heroku reachability, master-key fingerprint.
- `/admin/config` — effective config var snapshot (secrets masked).

Non-admins get 404 on these paths — they don't even discover the URLs exist.

## Architecture in one paragraph

Hono on `@hono/node-server`. One Postgres pool, six repositories (users,
heroku_tokens, connection_tokens, oauth_clients, oauth_authorizations,
oauth_tokens) plus an audit_log table. Master KEK loaded once at boot;
per-user DEK generated on first sign-in and wrapped under the KEK. Heroku
OAuth access/refresh tokens encrypted with the DEK. Connection and
OAuth-issued tokens hashed (never stored plaintext). Web sessions and
OAuth-flow state both live in self-contained encrypted cookies. MCP
transport: per-session `StreamableHTTPServerTransport` over a fresh
`McpServer` per Mcp-Session-Id, with the audit-wrapper installed at
construction time so every tool call writes one audit row. The `/mcp`
middleware tries `oauth_tokens` first, falls back to `connection_tokens`,
and emits a `WWW-Authenticate: Bearer resource_metadata=…` header on 401
so OAuth-aware clients (Claude Desktop) can discover the auth server.

See `PHASE-4.5.md` for the OAuth provider layer design, and
`notes/divergences.md` for the decisions that diverged from the original
docs.
