# Heroku Platform MCP — Customer-Facing Roadmap to 1.0

**Revised 2026-05-28.** The Partner MCP has been pulled out of the critical path entirely and parked as a standalone project (`notes/PARTNER-PROJECT-SNAPSHOT.md`). This roadmap takes the **customer-facing** Platform MCP straight to a 1.0 release with nothing blocking on Partner work.

---

## Shipped (done)

| Phase | What | Tag |
|---|---|---|
| 0 | `@heroku-mcp/core` shared library (client, prober, confirm, dry-run, crypto, audit, etag, pagination, ratelimit, redact, schema, tokens) | `core-v0.1.0` |
| 1 | `heroku-platform-mcp` — 56 read-only tools, stdio | `platform-v0.1.0` |
| 2a | App-tier write tools (confirm/dry_run) | shipped |
| 2b | Account + teams write tools | shipped |
| 3 | Enterprise + spaces + add-ons + pipelines tiers | shipped |
| 4 | HTTP transport + Heroku OAuth + hosted multi-user | `http-server-v0.1.0`, `platform-v0.5.0` |
| 4.5 | OAuth 2.1 provider layer (DCR/authorize/token/revoke + `.well-known`) for Claude Desktop Custom Connector | `http-server-v0.2.0` |
| patch | Zod `.nullish()` fix + regression tests | `http-server-v0.2.1` |
| patch | `apps_list_all` meta-tool (unions personal + all teams) | `platform-v0.5.1` |
| patch | Token refresh wiring + SSE `RESPONSE_ALREADY_SENT` header fix + typed re-auth error | `http-server-v0.2.2` (in progress) |

**State:** 240 tools, read + write, stdio + HTTP + OAuth, verified end-to-end against real Claude Desktop with real data (558 apps across 25 teams via `apps_list_all`). The customer Platform MCP is functionally complete; what remains is deployability, breadth (data APIs), scale (tool-count management), and release hardening.

---

## Remaining phases (straight line to 1.0)

### Phase 5 — `herokumcp-platform-deploy` (Heroku Button repo)  ← NEXT
**Why next:** removes ngrok — the single biggest source of testing friction. Gives a stable HTTPS URL so the Claude Desktop Custom Connector "just works" with the OAuth redirect set **once** instead of re-updated every ngrok restart. Makes the whole thing deployable by anyone with a Heroku account.
**Scope (small):** `app.json` (declares `HEROKUMCP_*` config vars, Postgres addon, master-key generation guidance), `Procfile`, Heroku Button in README, deploy walkthrough, post-deploy steps (set `HEROKUMCP_PUBLIC_URL` to the dyno URL, register the OAuth client redirect once). DEPLOYMENT.md already has the "Connecting clients" section + `HEROKUMCP_PUBLIC_URL` row.
**Exit:** a one-click deploy yields a working hosted MCP at a stable URL; Custom Connector connects without manual redirect juggling.

### Phase 6 — Data APIs (Postgres / Key-Value / Kafka)
**Why:** the most-requested customer surface after core platform ops. ~40 tools.
**Scope:** wrap the Heroku Data product APIs (Postgres: info, credentials, backups, metrics; Key-Value Store; Kafka: topics, consumer groups). Reads first, then the safe subset of mutations behind confirm/dry_run. Capability-probe each data product (not every app has them).
**Note:** some data endpoints live on separate hosts / API versions — confirm base URLs and auth at build time; the core client may need a per-tier base-URL override.

### Phase 7 — Progressive disclosure / "code mode" (tool-count scaling)
**Why:** at ~240 tools the `tools/list` payload is already heavy; adding Data APIs (~280) and any future surface pushes context cost past the point where clients stuff everything into context. Clients with native tool-search (Claude Desktop, Claude Code) already try to cope by searching — sometimes badly (observed: a search for "apps" surfaced add-on tools instead of `apps_list`). This phase makes the server expose a small searchable tool index + on-demand tool loading, dropping per-turn tool context from ~50k+ tokens to ~5k regardless of total tool count.
**Scope:** implement the MCP progressive-disclosure / tool-search pattern; ensure tool descriptions are search-optimized (the "Returns X. Does NOT include Y." discipline from divergence #67 helps ranking).
**Exit:** total tool context stays roughly flat as tool count grows.

### Phase 8 — Hardening + 1.0.0 release
**Scope:**
- Rename the ambiguous `HEROKUMCP_TOKEN` env var (Platform divergence #55).
- Security pass: token redaction audit, constant-time comparisons everywhere, master-key handling docs, rate-limit behavior under load.
- Reactive token-refresh-on-401 if it was deferred from `http-server-v0.2.2` (proactive-only was acceptable for the patch; close the gap here).
- Docs polish: README, OAUTH.md, DEPLOYMENT.md, TOOLS.md final pass.
- Publish `@heroku-mcp/core`, `@heroku-mcp/platform`, `@heroku-mcp/http-server` to npm under the Stratis Global publisher.
- Tag `platform-v1.0.0` + `http-server-v1.0.0` + `core-v1.0.0`.
**Exit:** 1.0 published, deployable, documented, hardened.

---

## Parked separate track (NOT blocking 1.0)

**Partner MCP** — `@heroku-mcp/partner` + `partner-http-server` + `herokumcp-partner-deploy`. Fully specced in `notes/PARTNER-PROJECT-SNAPSHOT.md`, executable cold. Build after customer 1.0, or as an independent effort. Depends on the SAME published `@heroku-mcp/core`, so core improvements made during customer phases 5–8 propagate to it automatically when it's eventually built.

---

## Immediate next actions

1. Finish/verify `http-server-v0.2.2` (token refresh) — confirm a real token actually refreshes past expiry, confirm the header fix is committed, confirm bearer path still works.
2. Re-enable the parked stdio MCP in Claude Desktop config (`_disabled_mcpServers` → `mcpServers`); decide on `HEROKUMCP_TOOL_PREFIX` if running stdio + HTTP simultaneously.
3. Start Phase 5 (deploy repo).
