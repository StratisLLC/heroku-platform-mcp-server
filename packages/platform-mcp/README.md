# @heroku-mcp/platform

MCP server exposing the [Heroku Platform API](https://devcenter.heroku.com/articles/platform-api-reference) as tools for AI clients like Claude Desktop and Claude Code.

Part of [herokumcp](https://github.com/baliles/herokumcp). For full documentation, deployment guides, and the broader project context, see the main repo.

## Install

```bash
npm install @heroku-mcp/platform
```

Requires Node ≥ 20.

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

## Usage — HTTP (for hosted deployments)

The HTTP transport, sign-in flow, encrypted token storage, and Heroku Button deployment are introduced in Phase 4 and 5 of the project. *Not yet shipped.* See [the roadmap](https://github.com/baliles/herokumcp#roadmap).

## Tool surface

Tools are gated by runtime capability probing — the set you see depends on what your specific token can do.

| Tier | Read tools | Write tools | Phase |
|---|---|---|---|
| Diagnostic | 5 | — | 1 (shipped) |
| Account | 15 | *(coming Phase 2b)* | 1 / 2b |
| Apps | 36 | 47 | 1 / 2a (shipped) |
| Teams | *(coming Phase 2b)* | *(coming Phase 2b)* | 2b |
| Enterprise / Spaces / Add-ons / Pipelines | *(coming Phase 3)* | *(coming Phase 3)* | 3 |
| Data (Postgres / Redis / Kafka) | *(coming Phase 9)* | *(coming Phase 9)* | 9 |

Full catalog with parameters and endpoint mappings: [TOOLS.md](https://github.com/baliles/herokumcp/blob/main/TOOLS.md).

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

- [Main README](https://github.com/baliles/herokumcp) — project overview and quick start
- [Tools catalog](https://github.com/baliles/herokumcp/blob/main/TOOLS.md)
- [Architecture](https://github.com/baliles/herokumcp/blob/main/ARCHITECTURE.md)
- [Capability probes](https://github.com/baliles/herokumcp/blob/main/CAPABILITY_PROBES.md)

## License

[Apache-2.0](https://github.com/baliles/herokumcp/blob/main/LICENSE).
