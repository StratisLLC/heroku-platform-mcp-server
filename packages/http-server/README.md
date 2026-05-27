# `@heroku-mcp/http-server`

Hosted Streamable-HTTP MCP server for the Heroku Platform API.

Per-user OAuth sign-in. Encrypted Postgres token store. Full audit log. Admin UI.
Wraps the same 240 tools that the stdio binary
(`@heroku-mcp/platform`'s `herokumcp-platform` command) exposes, but
authenticates each MCP client with a long-lived bearer token (`hmcp_…`)
instead of a Heroku API token in the user's keychain.

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
export MCP_ADMIN_EMAILS=$(your-heroku-email)

pnpm --filter @heroku-mcp/http-server start
```

Visit <http://localhost:3000>, click **Sign in with Heroku**, complete the
OAuth round-trip, and copy the freshly-minted `hmcp_…` token from `/me`.

## Required env vars

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string. |
| `HEROKUMCP_MASTER_KEY` | 32-byte base64-encoded AES-256 KEK. Generate with `openssl rand -base64 32`. **Losing this makes every stored token unreadable**. |
| `HEROKUMCP_OAUTH_CLIENT_ID` | The OAuth client `id` from `heroku clients:create`. |
| `HEROKUMCP_OAUTH_CLIENT_SECRET` | The corresponding `secret`. |
| `HEROKUMCP_ADMIN_CONTACT` | Email/URL shown on access-denied pages. |

## Optional env vars

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port. |
| `HEROKUMCP_PUBLIC_URL` | derived from request | External base URL. |
| `HEROKUMCP_OAUTH_SCOPE` | `write-protected` | Heroku OAuth scope. |
| `MCP_ALLOWED_EMAILS` | (unset = anyone) | Comma-separated allowlist. |
| `MCP_ALLOWED_TEAMS` | (unset) | Comma-separated Heroku team allowlist. |
| `MCP_ADMIN_EMAILS` | (unset) | Comma-separated admin allowlist (gates /admin/*). |
| `HEROKUMCP_AUDIT_RETENTION_DAYS` | (unset = forever) | Daily cron prunes older audit rows. |
| `HEROKUMCP_LOG_LEVEL` | `info` | One of `debug`, `info`, `warn`, `error`. |
| `HEROKUMCP_DB_SSL` | `require` | `require` / `no-verify` / `off`. |

## Connecting Claude Desktop

Copy this into `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or the equivalent on your platform:

```json
{
  "mcpServers": {
    "heroku-platform": {
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer hmcp_..."
      }
    }
  }
}
```

The `/me` page renders a ready-to-paste version with your token already
embedded.

## Admin UI

If your email is in `MCP_ADMIN_EMAILS`, additional pages appear in the nav:

- `/admin/users` — every signed-in user, with "revoke all tokens" actions.
- `/admin/tokens` — every connection token, including revoked.
- `/admin/audit` — cross-user audit log with filters + CSV export.
- `/admin/status` — DB reachability, Heroku reachability, master-key fingerprint.
- `/admin/config` — effective config var snapshot (secrets masked).

Non-admins get 404 on these paths — they don't even discover the URLs exist.

## Architecture in one paragraph

Hono on `@hono/node-server`. One Postgres pool, three repositories (users,
heroku_tokens, connection_tokens) plus an audit_log table. Master KEK loaded
once at boot; per-user DEK generated on first sign-in and wrapped under the
KEK. Heroku OAuth access/refresh tokens encrypted with the DEK. Connection
tokens hashed (never stored plaintext). Web sessions and OAuth-flow state both
live in self-contained encrypted cookies (no `web_sessions` table). MCP
transport: per-session `StreamableHTTPServerTransport` over a fresh
`McpServer` per Mcp-Session-Id, with the audit-wrapper installed at
construction time so every tool call writes one audit row.

See `notes/divergences.md` (entries #45–#54) for the design decisions that
diverged from the original docs.
