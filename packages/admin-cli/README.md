# `@heroku-mcp/admin-cli`

Operator CLI for the hosted Heroku MCP server. Operates against the same
Postgres the HTTP server uses.

> Not affiliated with Salesforce or Heroku. See [TRADEMARKS.md](https://github.com/StratisLLC/heroku-platform-mcp-server/blob/main/TRADEMARKS.md).

## Install

The CLI ships as part of the workspace. After `pnpm install && pnpm -r build`,
invoke it as:

```bash
node packages/admin-cli/dist/bin.js <command>
```

…or, once published, `npx @heroku-mcp/admin-cli <command>`.

On a deployed Heroku app, the typical pattern is:

```bash
heroku run -a my-mcp 'node node_modules/@heroku-mcp/admin-cli/dist/bin.js <command>'
```

All commands take `--database-url <url>` (falling back to `$DATABASE_URL`).

## Commands

```
herokumcp-admin users list
herokumcp-admin users revoke-all-tokens --email alice@example.com

herokumcp-admin tokens list [--include-revoked]
herokumcp-admin tokens revoke --id <uuid>

herokumcp-admin audit tail [--limit 100] [--email alice@example.com] [--since 2026-05-01]
herokumcp-admin audit prune --before 2026-04-01 [--email alice@example.com]

herokumcp-admin status

herokumcp-admin db migrate
herokumcp-admin db status

herokumcp-admin keys gen                  # prints a fresh base64 master key
herokumcp-admin keys fingerprint          # prints SHA-256 fingerprint
herokumcp-admin keys rotate-master        # Phase 10; refuses for now
```

## Required env

| Var | When |
|---|---|
| `DATABASE_URL` | every command |
| `HEROKUMCP_MASTER_KEY` | `status`, `keys fingerprint` |
| `HEROKUMCP_DB_SSL` | optional; defaults to `require` |

Requires Node ≥ 24.

## Related

- [@heroku-mcp/http-server](https://www.npmjs.com/package/@heroku-mcp/http-server) — the deployed server this CLI administers
- [@heroku-mcp/core](https://www.npmjs.com/package/@heroku-mcp/core) — shared building blocks
- [Project documentation](https://github.com/StratisLLC/heroku-platform-mcp-server#readme)

## License

Apache-2.0
