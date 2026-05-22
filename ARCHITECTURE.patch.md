# ARCHITECTURE.md — Patches for Deployment & Auth

> Apply these changes to `ARCHITECTURE.md` before starting Phase 4. They reflect the deployment and auth decisions made in `DEPLOYMENT.md` and `AUTH.md`.
>
> Each section below identifies the existing ARCHITECTURE.md section to modify and shows the new content. Apply them in order.

## Patch 1 — Update §1 "Goals"

**Find:** the bullet that reads "Be operable by humans: clear error mapping, rate-limit awareness, paginated responses, audit trail."

**Add** the following bullets immediately after it:

- Support two deployment topologies as first-class peers: **local stdio** (one process per user, OS-keychain token storage) and **Streamable HTTP** (hosted, multi-user, OAuth-authenticated, encrypted Postgres token storage).
- For hosted deployments, use **Heroku OAuth as the user-authentication mechanism**. Users sign in with their Heroku account; their consented OAuth grant is the same credential the MCP uses to call Heroku on their behalf. No service accounts; no separate "log in" and "authorize Heroku access" steps.

## Patch 2 — Update §2 "Non-goals (v1)"

**Find:** the line "- Multi-tenant deployment. Both MCPs are designed to run as `stdio` servers per user."

**Replace with:**

- Operating a multi-tenant SaaS MCP. Customers deploy and operate their own instance via the Heroku Button (see `DEPLOYMENT.md`). We ship code and `app.json`; we do not custody other organizations' tokens.

**Add** at the end of §2:

- Just-in-time OAuth scope elevation. v1 uses a fixed scope per deployment (`write-protected` by default). Per-tool scope upgrades are a Phase 9+ improvement.
- A web UI beyond the minimum needed for sign-in and operator self-service (`/setup`, `/auth/heroku/login`, `/auth/heroku/callback`). No general-purpose admin dashboard; admin operations are CLI-driven via `heroku run`.

## Patch 3 — Replace §3 with a new §3 that distinguishes deployment from packaging

**Replace the entire §3 ("The two MCPs")** with the following:

### 3. The two MCPs

Two MCP servers, each available in both stdio and HTTP-hosted form. The MCP business logic is in a shared library that doesn't know which transport it's running under.

#### 3.1 `@heroku-mcp/platform` — Customer-facing

**Audience:** Heroku developers, team admins, enterprise admins, ops engineers.

**Two distributions of the same package:**

- **stdio** (`heroku-platform-mcp-stdio` binary). Local subprocess. Reads a personal API token from the OS keychain or `--token` flag.
- **HTTP** (`heroku-platform-mcp-server` binary). Long-running web server. Users sign in via Heroku OAuth at `write-protected` scope by default. Per-user OAuth tokens stored encrypted in Postgres. Distributed primarily via the `heroku-platform-mcp-deploy` Button repo.

The same `@heroku-mcp/platform` package backs both. The difference is purely the bootstrap layer in `src/index-stdio.ts` vs `src/index-http.ts`.

**Surface:** the entire Platform API at `api.heroku.com` plus the data-store APIs at `api.data.heroku.com`. Actual exposed tool set determined at runtime by capability probing (§5).

#### 3.2 `@heroku-mcp/partner` — Add-on Partner-facing

**Audience:** Engineers building or operating a Heroku add-on.

**Same dual-distribution.** stdio for local development; HTTP for team-shared deployments via `heroku-partner-mcp-deploy`.

**Credentials, either or both:**
1. **OAuth credentials** — see `AUTH.md`. For hosted Partner MCP, users sign in via Heroku OAuth using the partner's own existing OAuth client (not a fresh one). Per-resource access tokens for provisioned add-ons are stored separately in `addon_resources` (see `AUTH.md`).
2. **Manifest credentials** — the add-on manifest `id` and `api:password`, configured via env vars. Required for inbound webhook validation and the `addons.heroku.com` installs endpoint.

## Patch 4 — Update §4 "Repository layout"

**Find:** the existing repo tree.

**Add** these two top-level entries to the planned `packages/` layout:

```
heroku-mcp/
└── packages/
    ├── core/                       # (existing) @heroku-mcp/core
    ├── platform-mcp/               # (existing) @heroku-mcp/platform
    │   └── src/
    │       ├── index-stdio.ts      # NEW — stdio entrypoint, OS keychain token
    │       └── index-http.ts       # NEW — HTTP entrypoint, OAuth, Postgres token store
    ├── partner-mcp/                # (existing) @heroku-mcp/partner
    │   └── src/
    │       ├── index-stdio.ts      # NEW
    │       └── index-http.ts       # NEW
    └── http-server/                # NEW @heroku-mcp/http-server
        └── src/
            ├── server.ts           # Express/Hono app, MCP Streamable HTTP transport
            ├── auth/
            │   ├── oauth.ts        # Heroku OAuth client (authorize, callback, refresh)
            │   ├── session.ts      # web session management
            │   └── connection-tokens.ts
            ├── storage/
            │   ├── postgres.ts     # @heroku-mcp/core TokenStore implementation
            │   ├── migrations/     # SQL migrations
            │   └── envelope.ts     # AES-256-GCM envelope encryption
            ├── access-control.ts   # MCP_ALLOWED_EMAILS / MCP_ALLOWED_TEAMS
            ├── pages/              # /setup, /auth, error pages (server-rendered HTML)
            └── admin.ts            # admin CLI script (re-key, revoke, audit-tail)
```

`@heroku-mcp/http-server` is the shared HTTP/OAuth/Postgres glue. Both `platform-mcp/src/index-http.ts` and `partner-mcp/src/index-http.ts` import from it.

**Add** the two companion deploy repos (separate from the monorepo):

```
heroku-platform-mcp-deploy/         # separate repo
├── app.json
├── Procfile
├── package.json                    # depends on @heroku-mcp/platform from npm
├── src/server.ts                   # 30-line bootstrap that imports from @heroku-mcp/platform
├── src/scripts/postdeploy.ts
└── README.md                       # Heroku Button badge, OAuth setup walkthrough

heroku-partner-mcp-deploy/          # separate repo
├── (same shape)
```

## Patch 5 — Add a new §6.5 between §6 "Token storage" and §7 "Request lifecycle"

**Insert:**

### 6.5 HTTP transport — sessions and connection tokens

Hosted deployments (via the deploy repos) run the MCP under Streamable HTTP. Two layers of authentication operate side by side:

**Web layer (sign-in, setup pages).** Standard cookie-based sessions, signed with `MCP_SESSION_SECRET`, stored in the `web_sessions` table. Sessions are short-lived (24h sliding) and only authorize the operator-facing pages (`/setup`, `/auth/*`). They never authorize MCP tool calls directly.

**MCP layer (tool calls).** The MCP client (Claude Desktop, Claude Code) authenticates with a long-lived bearer token — the **MCP connection token**, prefixed `hmcp_`. The user generates it from `/setup` after signing in and pastes it into their Claude config. Storage is hashed-only (SHA-256); the plaintext is never persisted. See `AUTH.md` for the full lifecycle and rotation procedures.

The MCP connection token does *not* grant API access to Heroku directly. It identifies the user; the MCP server then looks up that user's stored Heroku OAuth tokens (encrypted) and uses those to call Heroku. This separation means a leaked connection token is contained and revocable without touching the user's Heroku account.

## Patch 6 — Generalize §6 "Token storage"

**Find:** the existing §6 content describing keychain + encrypted-file storage.

**Replace** with:

### 6. Token storage

The `TokenStore` interface in `@heroku-mcp/core` abstracts over three implementations. The choice is made by the bootstrap layer based on deployment context.

```ts
interface TokenStore {
  get(key: TokenKey): Promise<string | null>;
  set(key: TokenKey, value: string, meta?: TokenMeta): Promise<void>;
  delete(key: TokenKey): Promise<void>;
  list(prefix?: string): Promise<TokenKey[]>;
}

interface TokenKey {
  scope: 'platform-user' | 'partner-user' | 'partner-resource';
  userId?: string;       // for *-user scope
  resourceUuid?: string; // for partner-resource scope
}
```

**Implementations:**

1. **`KeychainTokenStore`** — used by stdio. Backed by OS keychain via `keytar`. Each `TokenKey` becomes a `(service, account)` pair: `service='heroku-mcp'`, `account='<scope>:<id>'`.

2. **`FileTokenStore`** — fallback for stdio when keychain is unavailable. AES-256-GCM encrypted JSON file at `$HEROKU_MCP_HOME/tokens.enc`. Key derived from `HEROKU_MCP_PASSPHRASE` via scrypt (N=2^14, r=8, p=1).

3. **`PostgresTokenStore`** — used by hosted HTTP deployments. Persists tokens with envelope encryption (see `AUTH.md`). Each token gets a per-record DEK wrapped by a KEK derived from `MCP_ENCRYPTION_KEY` via HKDF-SHA-256.

All three implementations are interchangeable from the perspective of the rest of the codebase. Tool implementations always call `tokenStore.get(...)` without knowing which backing store they're hitting.

## Patch 7 — Replace §15 "Phased delivery"

**Replace** the existing phase table with:

### 15. Phased delivery

| Phase | Scope | Repo | Acceptance |
|---|---|---|---|
| 0 | `@heroku-mcp/core` complete: client, schema, prober, tokens (keychain+file impls only), ratelimit, etag, errors, audit, redact. | heroku-mcp | Unit tests pass; smoke test against real token succeeds for `GET /account`. |
| 1 | `@heroku-mcp/platform` v0.1: account + apps tiers, read-only. Capability probing live. stdio transport only. | heroku-mcp | `tools/list` reflects probe results; reads against a real account work end-to-end. |
| 2 | Platform v0.2: writes for Apps/Config/Formation/Releases with confirm guards; Teams tier added. | heroku-mcp | Destructive ops require confirm; `dry_run` works; teams tools light up only when probe sees a team. |
| 3 | Platform v0.3: Enterprise, Spaces, Add-ons (consumer side), Pipelines, Review Apps. Full TOOLS.md coverage for stdio. | heroku-mcp | Full TOOLS.md tier coverage. |
| **4** | **`@heroku-mcp/http-server`**: HTTP transport, Heroku OAuth client, Postgres token store with envelope encryption, web sessions, connection tokens, access control, `/setup` page, admin CLI. Platform MCP HTTP entrypoint. | heroku-mcp | An end-to-end sign-in → setup → tool call works against a deployed instance. Admin CLI can revoke and re-key. |
| **5** | **`heroku-platform-mcp-deploy`** Button repo: `app.json`, `Procfile`, bootstrap, README with Button badge. Deploys cleanly via Heroku Button. | heroku-platform-mcp-deploy | Click-the-button-and-it-works for a fresh Heroku account. |
| 6 | `@heroku-mcp/partner` v0.1: OAuth lifecycle (grant exchange, refresh, backfill) + Partner subset of Platform API. stdio transport. | heroku-mcp | Round-trip against a sandbox add-on works; tokens persisted encrypted. |
| 7 | Partner v0.2: webhook validators + manifest tooling. HTTP entrypoint. | heroku-mcp | Given a captured raw Heroku request, the validator returns parsed payload + verdict. HTTP server runs same way as Platform. |
| **8** | **`heroku-partner-mcp-deploy`** Button repo. | heroku-partner-mcp-deploy | Click-the-button-and-it-works for a partner with their existing OAuth client. |
| 9 | Data APIs in `@heroku-mcp/platform`: Postgres, Key-Value Store, Kafka tools. | heroku-mcp | Tools gated by add-on type; treat 404 gracefully. |
| 10 | Hardening: docs, examples, release automation. First `1.0.0`. | all | First `1.0.0` tag; published to npm and Heroku Elements. |

Each phase ends with a changeset and a tagged release. `1.0.0` is cut after Phase 10.

## Patch 8 — Add a §17 "Cross-references"

**Add** at the end of the file:

### 17. Cross-references

- `CAPABILITY_PROBES.md` — probe matrix and runtime tool gating
- `TOOLS.md` — full tool catalog
- `DEPLOYMENT.md` — deployment models, operator workflow, runbook
- `AUTH.md` — OAuth flow, token storage, access control, session lifecycle
- `HANDOFF.md` — instructions for the Claude Code agent doing the build

When information conflicts across documents, the order of precedence is:
1. `ARCHITECTURE.md` (this file)
2. `AUTH.md` (security-sensitive decisions)
3. `CAPABILITY_PROBES.md` / `TOOLS.md` (the API surface)
4. `DEPLOYMENT.md` (operator-facing)
5. `HANDOFF.md` (process)

If you find an actual contradiction, stop and ask before resolving it.
