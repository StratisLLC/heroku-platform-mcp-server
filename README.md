# Heroku MCP

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

A pair of [Model Context Protocol](https://modelcontextprotocol.io) servers that expose the [Heroku Platform API](https://devcenter.heroku.com/articles/platform-api-reference) and the [Platform API for Partners](https://devcenter.heroku.com/articles/platform-api-for-partners) as MCP tools.

- **`heroku-platform-mcp`** — Customer-facing. Authenticates with a personal Heroku API token. Exposes account, apps, teams, enterprise, spaces, add-ons, pipelines, and data-store APIs.
- **`heroku-partner-mcp`** — Add-on Partner-facing. Authenticates with OAuth credentials and/or manifest credentials. Exposes the Partner subset of the Platform API plus webhook validators and manifest tooling.

Both servers share a common library, `@heroku-mcp/core`, which handles HTTP, schema fetching, capability probing, token storage, rate-limiting, ETag caching, pagination, error mapping, audit logging, and secret redaction.

## Status

**Phase 0** — `@heroku-mcp/core` foundations only. The platform and partner MCP servers are not yet implemented. See [ARCHITECTURE.md §15](./ARCHITECTURE.md#15-phased-delivery) for the delivery roadmap.

## Quick start

```bash
# requirements: Node >= 20, pnpm 9
pnpm install
pnpm -r typecheck
pnpm -r test
pnpm -r build
```

## Layout

```
packages/
  core/          @heroku-mcp/core    — shared library
  platform-mcp/  @heroku-mcp/platform — Customer server (not yet)
  partner-mcp/   @heroku-mcp/partner  — Partner server (not yet)
```

## Documents

- [ARCHITECTURE.md](./ARCHITECTURE.md) — canonical design
- [CAPABILITY_PROBES.md](./CAPABILITY_PROBES.md) — startup probe matrix
- [TOOLS.md](./TOOLS.md) — full tool catalog
- [TRADEMARKS.md](./TRADEMARKS.md) — usage policy

## License

[Apache-2.0](./LICENSE).

This project is not affiliated with, endorsed by, or sponsored by Salesforce or Heroku.
