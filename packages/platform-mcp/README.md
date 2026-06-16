# @heroku-mcp/platform

MCP server exposing the [Heroku Platform API](https://devcenter.heroku.com/articles/platform-api-reference) as tools for AI clients like Claude Desktop and Claude Code.

Part of [herokumcp](https://github.com/StratisLLC/heroku-platform-mcp-server). For full documentation, deployment guides, and the broader project context, see the main repo.

> Not affiliated with Salesforce or Heroku. See [TRADEMARKS.md](https://github.com/StratisLLC/heroku-platform-mcp-server/blob/main/TRADEMARKS.md).

## Install

```bash
npm install @heroku-mcp/platform
```

Requires Node ≥ 24.

## Usage — stdio (for local AI clients)

Stdio is the canonical mode for desktop/CLI AI clients like Claude Desktop and Claude Code.

```bash
# 1. Generate a Heroku API token
heroku authorizations:create -d "herokumcp"

# 2. Set it in the environment and run
export HEROKUMCP_TOKEN="HRKU-..."
npx @heroku-mcp/platform
```

Or use it directly in a Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "heroku": {
      "command": "npx",
      "args": ["-y", "@heroku-mcp/platform"],
      "env": {
        "HEROKUMCP_TOKEN": "HRKU-your-token-here"
      }
    }
  }
}
```

Restart Claude Desktop, then in a new conversation: *"What Heroku apps do I have?"*

## Usage — HTTP (for hosted, multi-user deployments)

For a team that wants Claude to manage shared Heroku resources behind per-user
OAuth sign-in, deploy [`@heroku-mcp/http-server`](https://www.npmjs.com/package/@heroku-mcp/http-server)
instead. It registers these Platform tools (plus the Postgres, Key-Value, and
Kafka tool packages) behind one OAuth-protected `/mcp` endpoint. See the
[project README](https://github.com/StratisLLC/heroku-platform-mcp-server#readme).

## Tool surface

This package exposes **127 tools** covering the Heroku Platform API. Tools are
gated by runtime capability probing — the set a client sees depends on what its
specific token can do. By category:

| Category | What it covers |
|---|---|
| Account | Account info, features, SMS/2FA number, invoices, credits |
| Apps | App lifecycle, config vars, formation/scaling, dynos, releases, logs, domains, SSL/SNI, buildpacks, slugs, collaborators, review apps |
| Builds | Build creation and inspection |
| Add-ons | Add-on provisioning, plans, attachments, config, webhooks, regions, services |
| Teams | Team membership, apps, invitations, and team-scoped add-ons |
| Enterprise | Enterprise accounts, members, and identity (SSO) |
| Spaces | Private Spaces, VPN connections, peerings, trusted IP ranges |
| Pipelines | Pipelines, couplings, and promotions |
| OAuth & keys | OAuth authorizations/clients, account keys |
| Diagnostics | `whoami`, schema/capability probes, telemetry, audit |

Full catalog with parameters and endpoint mappings: [TOOLS.md](https://github.com/StratisLLC/heroku-platform-mcp-server/blob/main/TOOLS.md).

## Safety

Every destructive operation supports two protections:

```jsonc
// Preview without executing
apps_delete({ app: "my-app", dry_run: true })
// → { ok: true, dry_run: true, data: { request, description } }

// Execute requires explicit confirmation matching the target name
apps_delete({ app: "my-app", confirm: "my-app" })
// → { ok: true, data: { ... } }
```

The MCP server itself never auto-fills `confirm`; the AI client must obtain explicit user acknowledgment before passing it.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `HEROKUMCP_TOKEN` | yes (if no `--token`) | The Heroku API token to authenticate as |
| `HEROKUMCP_HOME` | no | Override the config directory (default: `~/.config/herokumcp`) |
| `HEROKUMCP_LOG_LEVEL` | no | `debug` / `info` / `warn` / `error` (default: `info`) |
| `HEROKUMCP_LOG_FILE` | no | Mirror stderr to a file |

## Documentation

- [Main README](https://github.com/StratisLLC/heroku-platform-mcp-server) — project overview and quick start
- [Tools catalog](https://github.com/StratisLLC/heroku-platform-mcp-server/blob/main/TOOLS.md)
- [Architecture](https://github.com/StratisLLC/heroku-platform-mcp-server/blob/main/ARCHITECTURE.md)
- [Capability probes](https://github.com/StratisLLC/heroku-platform-mcp-server/blob/main/CAPABILITY_PROBES.md)

## Related

- [@heroku-mcp/core](https://www.npmjs.com/package/@heroku-mcp/core) — shared building blocks
- [@heroku-mcp/postgres](https://www.npmjs.com/package/@heroku-mcp/postgres), [@heroku-mcp/key-value](https://www.npmjs.com/package/@heroku-mcp/key-value), [@heroku-mcp/kafka](https://www.npmjs.com/package/@heroku-mcp/kafka) — sibling tool packages for Heroku data add-ons
- [@heroku-mcp/http-server](https://www.npmjs.com/package/@heroku-mcp/http-server) — the deployable HTTP server that exposes these tools to a team

## License

[Apache-2.0](https://github.com/StratisLLC/heroku-platform-mcp-server/blob/main/LICENSE).
