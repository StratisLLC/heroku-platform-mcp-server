# Heroku MCP — Deployment

> How the MCP servers are deployed and operated. The Heroku Button is the recommended path; alternatives are documented for completeness.

## Deployment models

Four supported models, in order of recommendation for a team adopting the MCP:

### 1. Heroku Button (recommended)

The operator clicks a "Deploy to Heroku" button in the README, fills in a small form, and gets a running MCP in their own Heroku account. The app is owned, billed, and operated by the customer; the project maintainers never touch the customer's tokens.

**When to use:** any team that already uses Heroku and wants their MCP near their data. This is the canonical path.

**What gets deployed:**
- One Heroku app per MCP (Platform or Partner)
- One Heroku Postgres `essential-0` add-on for the encrypted token store and session store
- One web dyno running the MCP HTTP server
- Config vars containing the Heroku OAuth client credentials and auto-generated secrets

**Trust model:**
- The customer owns the app, the dyno, the database, and all stored tokens.
- The customer creates the Heroku OAuth client; project maintainers have no access to it.
- Each MCP user signs in with their own Heroku account via OAuth and acts only with their own permissions.

### 2. Self-hosted container (advanced)

The customer runs the same Docker image elsewhere — their own Kubernetes cluster, ECS, fly.io, a bare VM, whatever. Same code, same env vars, different infrastructure. Useful for customers with compliance requirements that preclude running on Heroku itself.

**When to use:** rarely. If the team is sophisticated enough to run a hosted MCP outside Heroku, they're sophisticated enough to read `ARCHITECTURE.md` and figure it out. We document the env vars; we don't ship Kubernetes manifests in v1.

### 3. Local stdio (development and individual use)

A developer runs `npx @heroku-mcp/platform-stdio` on their laptop. The MCP reads their personal API token from the OS keychain. No HTTP, no OAuth, no Postgres — just a subprocess speaking stdio to a local MCP client (typically Claude Desktop or Claude Code).

**When to use:** individual developers, local development of the MCP itself, situations where there is no team and no infrastructure to host.

**Trust model:** the user owns everything; no other principals involved.

### 4. SaaS multi-tenant (not offered)

We do not operate a hosted MCP service. Customers run their own. This is a product decision, not a technical limitation, and it removes a large amount of compliance and operational surface that we'd otherwise own.

---

## Heroku Button — the operator workflow

This section is the canonical "how to deploy" guide. It assumes the operator has a Heroku account and the Heroku CLI installed.

### Step 1 — Create a Heroku OAuth client

Before clicking the button, the operator creates a Heroku OAuth client that the deployed MCP will use to sign users in. This is a one-time setup.

The operator picks an app name in advance (Heroku won't auto-assign one if we need the callback URL up front). For example, `my-team-heroku-mcp`. The OAuth client is then created with:

```bash
heroku clients:create \
  "My Team Heroku MCP" \
  https://my-team-heroku-mcp.herokuapp.com/auth/heroku/callback
```

The CLI prints:
```
=== My Team Heroku MCP
id:           01234567-89ab-cdef-0123-456789abcdef
secret:       fedcba98-7654-3210-fedc-ba9876543210
redirect_uri: https://my-team-heroku-mcp.herokuapp.com/auth/heroku/callback
```

The operator copies both `id` and `secret` for the next step.

If the operator can't pick an app name in advance (e.g. they want Heroku to auto-name it), they can deploy first with placeholder OAuth credentials, note the actual app URL Heroku assigns, then `heroku clients:update` to set the correct callback URL and re-deploy. We document this path in the README but recommend the pre-pick-the-name path.

### Step 2 — Click the Heroku Button

The README of `heroku-platform-mcp-deploy` (or `heroku-partner-mcp-deploy`) contains a "Deploy to Heroku" button. Clicking it opens Heroku's deploy form. The form prompts for:

| Field | Required | Notes |
|---|---|---|
| App name | yes | Must match the name used in the OAuth client callback URL. |
| Region | yes | US or EU. Pick what matches the team. |
| `HEROKU_OAUTH_CLIENT_ID` | yes | Paste the `id` from Step 1. |
| `HEROKU_OAUTH_CLIENT_SECRET` | yes | Paste the `secret` from Step 1. |
| `MCP_ALLOWED_EMAILS` | yes | Comma-separated emails who can use this MCP. The operator's email at minimum; teammates can be added later. `*` allows anyone who can authenticate via the OAuth client. |
| `MCP_OAUTH_SCOPE` | no | Defaults to `write-protected`. Set to `read-protected` for a read-only deployment. Other valid values: `global`, `write`, `read`, `identity`. |
| `MCP_ALLOWED_TEAMS` | no | Comma-separated Heroku team names. Members of these teams can use the MCP without being in `MCP_ALLOWED_EMAILS`. |
| `ALLOW_ACCOUNT_DELETION` | no | Defaults to `false`. Set to `true` only if you want destructive account-level tools exposed. |
| `LOG_LEVEL` | no | Defaults to `info`. Valid: `debug`, `info`, `warn`, `error`. |

The operator clicks "Deploy app". Heroku:
1. Authenticates the operator (or prompts them to log in if they aren't already).
2. Creates the app under the operator's Heroku account.
3. Provisions the Heroku Postgres add-on.
4. Auto-generates `MCP_ENCRYPTION_KEY` and `MCP_SESSION_SECRET` (32-byte random hex via the `generator: "secret"` mechanism in `app.json`).
5. Sets the operator-supplied config vars.
6. Builds and releases the app.
7. Runs the `postdeploy` script (runs DB migrations).
8. Redirects the operator to `success_url`, which is the MCP's own `/setup` page.

The whole process takes about a minute.

### Step 3 — Verify and sign in

The operator lands on the `/setup` page. The page does three things in order:

1. **Self-test.** Checks that all required config vars are present, that the database is reachable, and that the OAuth callback URL matches the current app URL. Surfaces any mismatch with the exact `heroku clients:update` command to fix it.
2. **Sign-in prompt.** "Sign in with Heroku" button. Clicking it starts the OAuth authorization-code flow against the configured client.
3. **After successful sign-in:** the page shows the operator's email and the URL of their newly-deployed MCP, plus a generated MCP connection string for use in Claude.

### Step 4 — Connect Claude

The setup page provides copy-paste configuration for the operator's MCP client. For Claude Desktop, it looks like:

```json
{
  "mcpServers": {
    "heroku-platform": {
      "url": "https://my-team-heroku-mcp.herokuapp.com/mcp",
      "headers": {
        "Authorization": "Bearer <generated MCP connection token>"
      }
    }
  }
}
```

The connection token is a per-user, long-lived (90-day default) credential issued by the MCP itself. It maps to the user's stored Heroku OAuth tokens. It is **not** a Heroku API token; it's an MCP-internal credential and is revocable from `/setup` without affecting the user's Heroku account.

### Step 5 — Add team members

The operator updates `MCP_ALLOWED_EMAILS` (via Heroku dashboard or `heroku config:set`) to include teammate emails. Teammates visit the MCP's `/setup` URL, click "Sign in with Heroku", consent, and get their own MCP connection string. Each user is independent; revocation of one user's connection token does not affect others.

---

## The `app.json` for `heroku-platform-mcp-deploy`

This is the actual file that goes in the deploy repo. It is the contract between the README's button and Heroku's `app-setups` API.

```json
{
  "name": "Heroku Platform MCP",
  "description": "Self-hosted Model Context Protocol server for the Heroku Platform API. Sign in with your Heroku account and let MCP-aware AI clients manage your apps, teams, and add-ons.",
  "repository": "https://github.com/your-org/heroku-platform-mcp-deploy",
  "logo": "https://your-cdn.example.com/heroku-mcp-logo.svg",
  "keywords": ["mcp", "heroku", "claude", "anthropic", "ai", "platform-api"],
  "website": "https://your-org.example.com/heroku-mcp",
  "success_url": "/setup",
  "stack": "heroku-24",
  "buildpacks": [
    { "url": "heroku/nodejs" }
  ],
  "formation": {
    "web": { "quantity": 1, "size": "basic" }
  },
  "addons": [
    { "plan": "heroku-postgresql:essential-0" }
  ],
  "env": {
    "HEROKU_OAUTH_CLIENT_ID": {
      "description": "The id from `heroku clients:create`. See README for instructions.",
      "required": true
    },
    "HEROKU_OAUTH_CLIENT_SECRET": {
      "description": "The secret from `heroku clients:create`. Keep this confidential.",
      "required": true
    },
    "MCP_ALLOWED_EMAILS": {
      "description": "Comma-separated emails permitted to use this MCP. Use '*' to allow anyone who can authenticate.",
      "required": true
    },
    "MCP_OAUTH_SCOPE": {
      "description": "OAuth scope requested at sign-in. Defaults to write-protected (read and write apps, teams, add-ons including config var values). Other values: global, write, read-protected, read, identity.",
      "value": "write-protected"
    },
    "MCP_ALLOWED_TEAMS": {
      "description": "Optional. Comma-separated Heroku team names. Members of these teams may use the MCP regardless of MCP_ALLOWED_EMAILS.",
      "required": false
    },
    "ALLOW_ACCOUNT_DELETION": {
      "description": "Set to 'true' to expose destructive account-level tools (DELETE /account, etc). Defaults to false.",
      "value": "false"
    },
    "LOG_LEVEL": {
      "description": "One of: debug, info, warn, error.",
      "value": "info"
    },
    "MCP_ENCRYPTION_KEY": {
      "description": "Auto-generated. Encrypts user OAuth tokens at rest. DO NOT change after first deploy or stored tokens will be unrecoverable.",
      "generator": "secret"
    },
    "MCP_SESSION_SECRET": {
      "description": "Auto-generated. Signs the MCP's web session cookies.",
      "generator": "secret"
    },
    "MCP_CONNECTION_TOKEN_TTL_DAYS": {
      "description": "How long per-user MCP connection tokens remain valid. Defaults to 90.",
      "value": "90"
    }
  },
  "scripts": {
    "postdeploy": "node ./dist/scripts/postdeploy.js"
  }
}
```

The `app.json` for `heroku-partner-mcp-deploy` is structurally identical but with different env vars (no `MCP_OAUTH_SCOPE` — Partner OAuth scoping is per-resource — and additional vars for the partner's manifest credentials and add-on client_secret). See `AUTH.md` for the Partner-side specifics.

## The `Procfile`

```
web: node dist/server.js
release: node dist/scripts/migrate.js
```

The `release` process runs database migrations on every deploy. Heroku runs `release` before promoting the new code to web dynos, so a failed migration prevents a broken release.

## The `package.json`

The deploy repo's `package.json` is intentionally thin. It depends on the published `@heroku-mcp/platform` package and adds the HTTP/OAuth/Postgres glue. Approximate shape:

```json
{
  "name": "heroku-platform-mcp-deploy",
  "private": true,
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js"
  },
  "dependencies": {
    "@heroku-mcp/platform": "^0.5.0",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "express": "^4.19.0",
    "pg": "^8.12.0",
    "kysely": "^0.27.0",
    "openid-client": "^5.6.0",
    "iron-session": "^8.0.0"
  }
}
```

These are illustrative — the actual list lands during Phase 5 build. Key principles:
- Pin major versions, range minor/patch
- No transitive dependencies with `postinstall` scripts
- Keep the dependency count low to minimize attack surface

## The postdeploy script

Lives at `src/scripts/postdeploy.ts`. Its job is small:

1. Run any database migrations not handled by the `release` process (mostly: there are none, but the script exists as an extension point).
2. Print the URL the operator should visit next (`https://<app>.herokuapp.com/setup`).
3. Exit cleanly.

Heroku's `app-setups` API surfaces `postdeploy.output` in the response, so anything we print here is visible to the operator as part of the deploy flow.

---

## Operator runbook

Day-to-day operations for the deployed MCP. This is what the README links to as "operating your MCP."

### Adding a user

```bash
heroku config:get MCP_ALLOWED_EMAILS -a my-team-heroku-mcp
# alice@example.com,bob@example.com
heroku config:set MCP_ALLOWED_EMAILS=alice@example.com,bob@example.com,charlie@example.com -a my-team-heroku-mcp
```

The new user then visits `/setup`, signs in with Heroku, and gets their own connection token. No restart needed; the env var is re-read on each request.

### Removing a user

```bash
heroku config:set MCP_ALLOWED_EMAILS=alice@example.com,bob@example.com -a my-team-heroku-mcp
```

The removed user's existing session and connection tokens are not automatically invalidated — they need to be revoked explicitly via the admin tool:

```bash
heroku run "node dist/scripts/admin.js revoke-user --email charlie@example.com" -a my-team-heroku-mcp
```

This clears their stored Heroku OAuth tokens, invalidates their connection tokens, and ends any active sessions.

### Rotating the OAuth client secret

If the operator suspects the OAuth client secret has been exposed:

```bash
heroku clients:rotate <client-id>
# CLI prints the new secret
heroku config:set HEROKU_OAUTH_CLIENT_SECRET=<new-secret> -a my-team-heroku-mcp
heroku ps:restart -a my-team-heroku-mcp
```

All users will need to sign in again on their next tool call; the MCP detects the rotation by observing 401s on token refresh.

### Rotating the MCP encryption key

This is the dangerous one. Changing `MCP_ENCRYPTION_KEY` makes all currently-stored Heroku OAuth tokens unreadable. Recovery procedure:

```bash
# 1. Put the app in maintenance mode
heroku maintenance:on -a my-team-heroku-mcp

# 2. Run the re-key script with both old and new keys
OLD_KEY=$(heroku config:get MCP_ENCRYPTION_KEY -a my-team-heroku-mcp)
NEW_KEY=$(openssl rand -hex 32)
heroku run "node dist/scripts/admin.js rekey --old-key $OLD_KEY --new-key $NEW_KEY" -a my-team-heroku-mcp

# 3. Update the config var
heroku config:set MCP_ENCRYPTION_KEY=$NEW_KEY -a my-team-heroku-mcp

# 4. Take maintenance mode off
heroku maintenance:off -a my-team-heroku-mcp
```

If for some reason the re-key fails or is impossible (e.g. the old key has been lost), users will be forced to re-authenticate. The admin tool supports this path:

```bash
heroku run "node dist/scripts/admin.js clear-all-tokens --i-understand-this-forces-reauth" -a my-team-heroku-mcp
```

### Viewing the audit log

The MCP keeps a JSONL audit log of every mutating tool call in the database. Operators can query it:

```bash
heroku run "node dist/scripts/admin.js audit-tail --limit 100" -a my-team-heroku-mcp

# Or filter by user, date, tool:
heroku run "node dist/scripts/admin.js audit-tail --user alice@example.com --since 2026-05-01" -a my-team-heroku-mcp
```

### Upgrading the MCP version

The deploy repo follows the same versioning as `@heroku-mcp/platform`. To upgrade, the operator either:

- **Re-deploys via the button** — re-runs the deploy with the latest code from the repo. Config vars are preserved.
- **Connects their own GitHub fork** — for teams that want to pin specific versions or apply patches. Standard Heroku GitHub integration applies.

CHANGELOG.md in the deploy repo lists breaking changes and required config var changes for each version. Migrations are designed to be backward-compatible across one minor version, so a stepwise upgrade path is always available.

### Tearing down

```bash
heroku apps:destroy --app my-team-heroku-mcp
heroku clients:destroy <client-id>
```

The first command destroys the app and the Postgres add-on (and therefore all stored tokens, sessions, and audit logs). The second destroys the OAuth client, which immediately invalidates any access tokens it issued — Heroku-side cleanup of any tokens the MCP might have leaked.

---

## Operator-facing security considerations

Things the README and operator-runbook should make explicit:

1. **The MCP can do whatever its users can do.** Sign-in with Heroku at `write-protected` scope means a user can modify apps, scale dynos, change config vars, manage team members, etc. Choose `MCP_ALLOWED_EMAILS` accordingly.
2. **The MCP's Postgres holds OAuth refresh tokens.** Compromise of the database = compromise of every user's Heroku OAuth tokens (limited to the scope granted, not full account access). The `MCP_ENCRYPTION_KEY` is the mitigation: tokens are encrypted at rest with envelope encryption. Don't put the key in a shared config var management tool that's less protected than Heroku itself.
3. **The MCP connection token is bearer-style.** Whoever has it can call the MCP as the user it belongs to. It's revocable; users should re-issue it if their Claude config syncs to a device they no longer control.
4. **There is no `MCP_ADMIN_*` user.** Operations like rotation and revocation use the admin script, which runs as the Heroku app user via `heroku run`. Anyone with `heroku run` access on the app can run admin commands. Audit `heroku access` on the app.
5. **Logs may contain sensitive metadata.** Audit log entries include user email, tool name, target resource name. They never contain config values, tokens, or response bodies. Still: Heroku log drains to a third-party service should be considered when scoping data residency.
6. **Account deletion is hidden by default.** `ALLOW_ACCOUNT_DELETION=false` means tools like `account_delete` and `keys_delete` are not advertised. Only enable if you really want those tools available and trust every email in your allowlist.

---

## Phase 4 implementation reality (corrections to the above)

The original DEPLOYMENT.md predated the Phase 4 build. The shipped HTTP
server matches the spirit of the operator runbook above but differs in
several names and a few mechanisms. The list below supersedes the
corresponding parts of this doc; the long-form prose above stays for context.

**Env var names.** The shipped code reads:

| Old name in doc | Shipped name |
|---|---|
| `MCP_ENCRYPTION_KEY` | `HEROKUMCP_MASTER_KEY` (base64 32B; `openssl rand -base64 32`) |
| `MCP_OAUTH_SCOPE` | `HEROKUMCP_OAUTH_SCOPE` (default `write-protected`) |
| `MCP_SESSION_SECRET` | (not used — session cookies use the master key directly) |
| `MCP_CONNECTION_TOKEN_TTL_DAYS` | (not used — connection tokens have no expiry; revoke via the UI) |
| `MCP_OPERATOR_CONTACT` | `HEROKUMCP_ADMIN_CONTACT` (REQUIRED) |
| `ALLOW_ACCOUNT_DELETION` | (n/a — `account_delete` is not implemented at all; see notes/divergences.md #18) |

The names that did NOT change: `DATABASE_URL`, `MCP_ALLOWED_EMAILS`,
`MCP_ALLOWED_TEAMS`, `MCP_ADMIN_EMAILS` (new), `LOG_LEVEL`
(renamed `HEROKUMCP_LOG_LEVEL`).

**OAuth client setup.** `heroku clients:create` still applies; the redirect
URI is `https://<app>/oauth/callback` (the path is `/oauth/callback`, not
`/auth/heroku/callback`).

**Admin CLI.** The runbook above describes
`node dist/scripts/admin.js revoke-user`. The shipped CLI is
`@heroku-mcp/admin-cli` invoked as `herokumcp-admin`. Equivalent commands:

| Doc command | Shipped command |
|---|---|
| `admin.js revoke-user --email X` | `herokumcp-admin users revoke-all-tokens --email X` |
| `admin.js audit-tail --limit N --since D` | `herokumcp-admin audit tail --limit N --since D` |
| `admin.js rekey` | (deferred to Phase 10; `herokumcp-admin keys rotate-master` is a stub) |
| `admin.js clear-all-tokens` | (manual SQL: `DELETE FROM heroku_tokens`) |

**Sessions and OAuth flow state.** The runbook above assumes a
`web_sessions` table. The shipped code uses encrypted cookies sealed under
the master key instead, so there is no `web_sessions` row to inspect. The
trade-off is documented in `notes/divergences.md` #49.

**dynos_run.** Shipped in buffered mode in the HTTP server (DECISION 8).
Reads the rendezvous WebSocket until close, a configurable duration limit, or
a configurable output byte limit — whichever hits first. Interactive sessions
still need `heroku run` from a local terminal.

**Audit retention.** Phase 4 adds `HEROKUMCP_AUDIT_RETENTION_DAYS` (default
unset = keep forever). When set, a daily prune runs in-process. The CLI
`audit prune --before <iso>` is the manual fallback.
