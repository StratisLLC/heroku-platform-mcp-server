# Heroku Platform MCP Server

> Self-hosted, OAuth-protected MCP server that exposes the Heroku platform as
> agent-callable tools — apps, dynos, Postgres, Key-Value, Kafka — over HTTP, talking
> directly to the Heroku Platform API (no CLI), with Dynamic Client Registration and a
> token-optimized discovery endpoint.

**[Quickstart & docs →](https://stratisllc.github.io/heroku-platform-mcp-server/)**

---

## What this is

An MCP (Model Context Protocol) server that lets any MCP-aware agent — Claude, or any
spec-compliant client — operate your Heroku resources as tools. You deploy it (or point
at a shared instance), authenticate with your own Heroku account, and the agent acts on
your behalf using your own permissions. Credentials are never shared with the host;
tools run scoped to the signed-in user.

- **Direct Platform API, no CLI.** The server talks straight to the Heroku Platform API
  over HTTPS. Nothing to install on the host, no CLI to shell out to, no local auth
  session to manage — just a clean HTTP service.
- **Self-hosted.** Runs as a normal Heroku app you control. One-click deploy.
- **OAuth-protected, multi-user.** Each user signs in with their own Heroku account; the
  server stores tokens encrypted at rest and acts per-user.
- **HTTP + Dynamic Client Registration.** Standard MCP over HTTP. DCR means most clients
  connect with just a URL — no manual client_id/secret juggling.
- **Two endpoints, one for context budget.** A full flat catalog, and a token-optimized
  discovery endpoint that cuts initial context cost by ~87%.

## Not to be confused with the official Heroku MCP server

There is an official, Heroku-published MCP server — `heroku/heroku-mcp-server` — which
runs **locally over STDIO and wraps the Heroku CLI** (it requires the CLI installed
globally and launches via `heroku mcp:start`). It's a good fit for a single developer
working at their own machine with their own CLI session.

**This project is a different shape, for a different job:**

| | This project | Official `heroku/heroku-mcp-server` |
|---|---|---|
| Transport | HTTP (remote) | STDIO (local) |
| Engine | **Direct Heroku Platform API over HTTPS** | Wraps the Heroku CLI |
| Auth | Per-user OAuth, multi-user | Local CLI session / API key, single-user |
| Hosting | Self-hosted Heroku app | Runs on your machine |
| Client onboarding | Dynamic Client Registration | Per-machine config |
| Discovery | Optional token-optimized endpoint | — |

Use the official one for local, single-user, CLI-backed workflows. Use **this** when you
want a hosted, OAuth-protected, multi-user server that any remote MCP client can connect
to over the network — with no CLI dependency and nothing to install on the host.

## Tools

**276 tools** across four tiers (241 platform · 22 Postgres · 8 Key-Value · 5 Kafka):

- **Platform (241)** — apps, dynos, builds, releases, config vars, add-ons, formations,
  pipelines, teams, spaces, webhooks, domains, OAuth clients, enterprise/usage. Reads
  plus extensive write and lifecycle operations.
- **Heroku Postgres (22)** — database info, credentials, backups, followers, maintenance,
  replication status, plus writes: credential create/rotate/destroy, backup
  capture/delete/schedule, maintenance-window set.
- **Key-Value Store / Redis (8)** — info, credentials, plus config writes (maxmemory,
  timeout, keyspace notifications), stats reset, credential reset.
- **Apache Kafka on Heroku (5)** — read-only: cluster info, topics, consumer groups.

Every destructive or write operation (delete, restart, scale, rollback, credential and
backup writes, config changes) requires an explicit confirmation value — an agent cannot
fill it from the same turn that requested the action, so nothing irreversible happens
without deliberate authorization. Many tools also support `dry_run`.

## Two endpoints

Both serve the same tools. The difference is *when* tool schemas hit your context window.

| | `/mcp` | `/mcp-codemode` |
|---|---|---|
| Style | Full flat catalog (276 tools) | Discovery meta-tools (`search`, `execute`, `auth_status`) |
| Initial schema cost | ~60,826 tokens | ~585 tokens |
| Discovery | All tools up front | On-demand |
| End-to-end token reduction | — | ~87% |

Use `/mcp` when you don't care about context budget or your client lacks on-demand
discovery. Use `/mcp-codemode` when context tokens matter — functionally identical,
dramatically cheaper to start. You can switch at any time; the two coexist.

## Get started

Two paths, same server:

1. **Use a shared instance.** Point your MCP client at an existing deployment and
   authenticate with your own Heroku account.
2. **Deploy your own.** One-click deploy to Heroku. The deploy form needs a Heroku OAuth
   client ID and secret (the credentials the server uses to call Heroku) — create them
   with one CLI command, then click the button. See
   **[SETUP.md](https://github.com/StratisLLC/heroku-platform-mcp/blob/main/SETUP.md)**
   for the exact ordering.

Full walkthrough on the **[quickstart page](https://stratisllc.github.io/heroku-platform-mcp-server/)**.

### Connect from Claude

1. Settings → Connectors → Add custom connector.
2. Paste your endpoint URL (`/mcp` or `/mcp-codemode`).
3. Leave the connector's OAuth Client ID and Secret blank — the server registers them
   automatically via DCR. (This is unrelated to the Heroku OAuth client you created at
   deploy time.)
4. Click Add, sign in to Heroku, Authorize.
5. Connected — your Heroku resources are now available to the agent.

## Sample MCP Prompts

Ready-to-paste prompts to try the server the moment you connect. Each starts by asking
which enterprise org to scope to, so it never sweeps across everything you can reach.
Start with #1 — it works on any deployment. #3 is the showcase but needs elevated access
(see its note).

| # | Prompt | What it does | Scope |
|---|--------|--------------|-------|
| 1 | [Fleet Overview](PROMPT-1-fleet-overview.md) | Pick one enterprise org; inventory every app's region, formation, add-ons, and latest release into one structured overview with totals and flags. Read-only. | Default — everyone |
| 2 | [Release & Health Investigation](PROMPT-2-release-health-investigation.md) | Pick an org and an app; run a multi-step, on-call-style health review — drift, recent changes, config sanity, dependency health, cited verdict. Read-only. | Default — everyone |
| 3 | [Six-Month Usage Analysis & Optimization Report](PROMPT-3-usage-analysis-report.md) | Pick an org; pull six months of usage and build a downloadable report with charts, raw-data tables, observations, and Heroku-doc-grounded cost suggestions. | ⚠️ `global` + billing/enterprise-admin |

> New here? Paste **Fleet Overview** first — read-only, no special permissions, shows the
> breadth of the platform in one run.

## A note on usage/billing access

Usage and billing tools are gated twice: the server must run with `global` OAuth scope
(not the default `identity,write-protected`), **and** the signed-in Heroku user must hold
billing or enterprise-admin permission. `global` alone is not enough. This is Heroku's
own guard on sensitive data, not a limitation of the server.

## Documentation

- [Quickstart](https://stratisllc.github.io/heroku-platform-mcp-server/)
- [Code Mode details](docs/CODE-MODE.md)
- [OAuth client setup](docs/OAUTH-SETUP.md)
- [Changelog](CHANGELOG.md)
- [Security](SECURITY.md)

## Packages

Published under the [`@heroku-mcp`](https://www.npmjs.com/org/heroku-mcp) npm org.

## License

Apache-2.0 · Published by Stratis, LLC.

Salesforce and the Salesforce logo are trademarks of Salesforce, Inc. Heroku and the
Heroku logo are trademarks of Salesforce, Inc. This is an independent open-source project
and is not affiliated with, endorsed by, or sponsored by Salesforce.
