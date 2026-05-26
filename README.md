# herokumcp

[![CI](https://github.com/baliles/herokumcp/actions/workflows/ci.yml/badge.svg)](https://github.com/baliles/herokumcp/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-green.svg)](https://nodejs.org)

**Model Context Protocol servers for the Heroku Platform API.** Lets AI clients like Claude Desktop and Claude Code manage Heroku apps, teams, add-ons, and pipelines through natural conversation.

> **Status:** Under active development. Phases 0–2a complete (read + apps-tier writes), Phase 2b in progress (account writes + teams tier). Not yet at `1.0.0`. See [Roadmap](#roadmap).

---

## What this is

The [Model Context Protocol](https://modelcontextprotocol.io) (MCP) is an open standard that lets AI assistants talk to external systems through a uniform interface. This project ships two MCP servers that expose Heroku's APIs as MCP tools:

- **`@heroku-mcp/platform`** — for customers managing their Heroku apps, teams, and add-ons
- **`@heroku-mcp/partner`** — for add-on partners managing their listings and customer resources *(planned)*

Both servers share a common core library (`@heroku-mcp/core`) handling HTTP, schema discovery, capability probing, encrypted token storage, and audit logging.

Three things make this design notable:

1. **Runtime capability discovery.** The tools you see depend on what your specific Heroku token can actually do. A read-only token gets read-only tools; an enterprise admin token gets enterprise tools; the tier surface is determined by probing, not hardcoded.
2. **Two-tier safety for destructive operations.** Every mutating tool supports `dry_run: true` to preview the change without executing. Destructive operations additionally require a `confirm` parameter matching a specific target identifier (typically the resource name) before they fire.
3. **Designed to be self-hosted on Heroku.** A one-click [Heroku Button](https://devcenter.heroku.com/articles/heroku-button) deployment is planned for Phase 5 — you'll get your own MCP running in your own Heroku account, signed in with your own Heroku account.

---

## Quick start

Right now the project supports **local stdio mode** for individual developers. Hosted HTTP mode and the Heroku Button arrive in Phases 4 and 5 respectively.

### Local with Claude Desktop

```bash
# 1. Clone, install, build
git clone https://github.com/baliles/herokumcp.git
cd herokumcp
pnpm install
pnpm -r build

# 2. Generate a Heroku API token for the MCP to use
heroku authorizations:create -d "herokumcp local"
# Copy the HRKU-... value the CLI prints
```

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent on your platform:

```json
{
  "mcpServers": {
    "heroku": {
      "command": "node",
      "args": [
        "/absolute/path/to/herokumcp/packages/platform-mcp/dist/index-stdio.js"
      ],
      "env": {
        "HEROKUMCP_TOKEN": "HRKU-your-token-here"
      }
    }
  }
}
```

Restart Claude Desktop. In a new conversation, try:

> What Heroku apps do I have?

Claude should respond with your actual app list. If it works, congratulations — you've just connected an AI client to the Heroku API.

For full installation and configuration details see [`docs/installation.md`](docs/installation.md) *(coming soon)*.

---

## What you can do

The currently shipped tool surface (Phases 0–2a) covers:

| Tier | Read tools | Write tools | Probe gating |
|---|---|---|---|
| **Diagnostic** | 5 | — | Always available |
| **Account** | 15 | *(coming Phase 2b)* | Token must authenticate |
| **Apps** | 36 | 47 | Token must have ≥1 app or `/apps` reachable |
| **Teams** | *(coming Phase 2b)* | *(coming Phase 2b)* | Token must be in ≥1 team |
| **Enterprise** | *(coming Phase 3)* | *(coming Phase 3)* | Token must be in ≥1 enterprise account |
| **Spaces** | *(coming Phase 3)* | *(coming Phase 3)* | Token must have access to ≥1 space |
| **Add-ons (consumer)** | *(coming Phase 3)* | *(coming Phase 3)* | Token must have ≥1 add-on |
| **Pipelines** | *(coming Phase 3)* | *(coming Phase 3)* | Token must have ≥1 pipeline |
| **Data (Postgres/Redis/Kafka)** | *(coming Phase 9)* | *(coming Phase 9)* | Per-add-on |

**Current total: 103 tools.** Full target after Phase 9: ~250 tools.

For the complete tool catalog with parameters and endpoint mappings see [`TOOLS.md`](TOOLS.md).

---

## Safety

Three design choices that protect against accidental damage:

1. **Capability probing.** You can only call tools your token actually has access to. No surprise 403 errors mid-conversation.
2. **`dry_run` for every write.** Pass `dry_run: true` and the tool returns a structured preview of what *would* happen (including the would-be HTTP request and a human-readable description) without executing. For delete operations, the preview includes the current state of the resource being deleted.
3. **`confirm` for every destructive op.** Tools that delete, rotate, transfer ownership, or otherwise cause irreversible change require a `confirm` parameter matching the target identifier exactly. The MCP server itself never auto-fills `confirm`; the AI client is expected to obtain explicit user acknowledgment before passing it.

For the full security model — including the OAuth design for hosted deployments, the envelope-encryption scheme for token storage, and the audit logging architecture — see [`AUTH.md`](AUTH.md).

---

## Documentation

Most documentation is currently in the repo root and will reorganize into `docs/` as the project matures.

- **[`ARCHITECTURE.md`](ARCHITECTURE.md)** — overall design, repo layout, lifecycle, security model, delivery phases
- **[`AUTH.md`](AUTH.md)** — authentication design for the hosted MCP (OAuth flow, token storage, sessions, access control)
- **[`DEPLOYMENT.md`](DEPLOYMENT.md)** — the Heroku Button deployment model and operator runbook *(applies starting Phase 5)*
- **[`TOOLS.md`](TOOLS.md)** — every tool with parameters, endpoint mappings, and confirm/dry_run flags
- **[`CAPABILITY_PROBES.md`](CAPABILITY_PROBES.md)** — the runtime probe matrix that determines which tools light up
- **[`NAMING.md`](NAMING.md)** — naming conventions used throughout the project
- **[`notes/divergences.md`](notes/divergences.md)** — running log of cases where Heroku's actual API differs from documented behavior

---

## Project status

| Component | Latest | Status |
|---|---|---|
| `@heroku-mcp/core` | `0.1.0` (queued) | Phase 0 complete |
| `@heroku-mcp/platform` | `0.2.0` (queued) | Phases 1 and 2a complete; Phase 2b in progress |
| `@heroku-mcp/partner` | — | Phase 6+ |
| `@heroku-mcp/http-server` | — | Phase 4 |
| `herokumcp-platform-deploy` | — | Phase 5 |
| `herokumcp-partner-deploy` | — | Phase 8 |

Not yet published to npm. Will publish at `1.0.0` after Phase 10. See [`CHANGELOG.md`](CHANGELOG.md) for per-version details.

---

## Roadmap

The project ships in phases. Each phase has a clear scope and acceptance criteria; we tag a release at the end of each.

| Phase | Scope | Status |
|---|---|---|
| 0 | `@heroku-mcp/core` shared library | ✅ shipped |
| 1 | `@heroku-mcp/platform` stdio server, read-only, with capability probing | ✅ shipped |
| 2a | Apps-tier writes with `confirm` + `dry_run` safety patterns | ✅ shipped |
| 2b | Account-tier writes + teams tier (read + write) | 🚧 in progress |
| 3 | Enterprise, Spaces, Add-ons consumer, Pipelines tiers | planned |
| 4 | HTTP transport, Heroku OAuth, Postgres token store, web sign-in UI | planned |
| 5 | `herokumcp-platform-deploy` Heroku Button repo | planned |
| 6 | `@heroku-mcp/partner` OAuth lifecycle + Partner API subset | planned |
| 7 | Partner webhook validators + manifest tooling + HTTP entrypoint | planned |
| 8 | `herokumcp-partner-deploy` Heroku Button repo | planned |
| 9 | Data APIs (Postgres / Redis / Kafka) | planned |
| 10 | Hardening, docs, examples, `1.0.0` release | planned |

---

## Contributing

Issue reports, pull requests, and feedback are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for local development setup, the test workflow, and how to add a new tool or capability tier.

For security issues, see [`SECURITY.md`](SECURITY.md) — please do not file public issues for vulnerabilities.

---

## License

[Apache-2.0](LICENSE). See also [`TRADEMARKS.md`](TRADEMARKS.md) for the Heroku-name disclaimer.

Heroku is a trademark of Salesforce, Inc. This project is independent and not affiliated with or endorsed by Salesforce.
