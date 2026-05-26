# @heroku-mcp/platform

Customer-facing Heroku Platform MCP server. Connects to `api.heroku.com` with a personal API token and exposes Heroku as a set of MCP tools.

Phase 1 (this version): **account** and **apps** tiers, read-only. Capability probing live — only tools backed by endpoints the token can reach are advertised.

## Run

```bash
HEROKUMCP_TOKEN=HRKU-... node dist/index-stdio.js
# or
node dist/index-stdio.js --token HRKU-...
```

The binary speaks the Model Context Protocol over stdio.

## Claude Desktop wiring

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "herokumcp-platform": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index-stdio.js"],
      "env": { "HEROKUMCP_TOKEN": "HRKU-..." }
    }
  }
}
```
