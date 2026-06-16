# @heroku-mcp/key-value

Heroku Key-Value Store (Redis) tools for the Heroku MCP server. Sibling of
[`@heroku-mcp/platform`](../platform-mcp) and [`@heroku-mcp/postgres`](../postgres-mcp).
This package is a library: the hosted HTTP server registers its tools alongside
the Platform and Postgres tools so connecting clients (e.g. Claude Desktop) see
one merged catalog.

> Not affiliated with Salesforce or Heroku. See [TRADEMARKS.md](https://github.com/StratisLLC/heroku-platform-mcp-server/blob/main/TRADEMARKS.md).

## Install

```bash
npm install @heroku-mcp/key-value
```

Requires Node ≥ 24.

## What's included

Pure HTTP control-plane tools (no Redis-protocol data operations, no CLI
shellout). Eight tools:

| Group | Tools |
| --- | --- |
| Inventory & info | `kv_list`, `kv_info` |
| Credentials | `kv_credentials`, `kv_credentials_reset` |
| Config & maintenance | `kv_maxmemory_set`, `kv_timeout_set`, `kv_keyspace_notifications_set`, `kv_stats_reset` |

Deliberately **not** in this package: `kv_upgrade` / `kv_promote` (deferred to a
later part), `kv_wait` (belongs in platform-mcp as a generic `addon_wait`), and
any Redis-protocol tools (`GET`/`SET`/`KEYS`/…) — an explicit data-plane scope
decision.

## Endpoints & auth

Key-Value operations span two hosts:

- **Platform API** (`api.heroku.com`) — `kv_list` pages `/addons` and filters to
  the `heroku-redis` service client-side (the Platform API has no server-side
  service filter), authenticated with the OAuth **bearer** token.
- **Heroku Data API** (`api.data.heroku.com/redis/v0/...`) — everything else
  (info, credentials, config, stats, rotation), authenticated with HTTP
  **Basic** auth (empty username, OAuth token as password), mirroring
  `@heroku-mcp/postgres`'s `/postgres/v0` namespace.

## Sensitive data

The instance password lives in the `resource_url` (`rediss://:<password>@host:port`).
`kv_info` strips `resource_url` entirely; `kv_credentials` returns the URL with
the password masked to `***` plus the bare host/port. The raw password is never
returned to the model.

## Confirmation

Every mutating tool (`kv_credentials_reset`, `kv_stats_reset`, the three config
setters) requires a `confirm` argument equal to the add-on name, enforced by
core's `assertConfirm` (the same envelope contract as `@heroku-mcp/postgres`).

## Capability probing

Gated on the `data.redis` root tier (core `data.redis_root` probe). The config
setters additionally guard the `data.kv_config` sub-tier (`KEYVALUE_PROBES`).
When the root tier is unavailable, no Key-Value tools are advertised.

## Related

- [@heroku-mcp/core](https://www.npmjs.com/package/@heroku-mcp/core) — shared building blocks
- [@heroku-mcp/platform](https://www.npmjs.com/package/@heroku-mcp/platform) — Heroku Platform API tools
- [@heroku-mcp/http-server](https://www.npmjs.com/package/@heroku-mcp/http-server) — the deployable HTTP server that exposes these tools
- [Project documentation](https://github.com/StratisLLC/heroku-platform-mcp-server#readme)

## License

Apache-2.0
