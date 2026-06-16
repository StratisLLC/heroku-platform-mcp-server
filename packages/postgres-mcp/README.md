# @heroku-mcp/postgres

MCP tools for Heroku Postgres: database info, credentials, backups, followers, maintenance, and write operations. Sibling of [`@heroku-mcp/platform`](../platform-mcp).

This package is a library: the hosted HTTP server registers its tools alongside the Platform tools so connecting clients (e.g. Claude Desktop) see one merged catalog.

> Not affiliated with Salesforce or Heroku. See [TRADEMARKS.md](https://github.com/StratisLLC/heroku-platform-mcp-server/blob/main/TRADEMARKS.md).

## Install

```bash
npm install @heroku-mcp/postgres
```

Requires Node ≥ 24.

## What's included

**22 tools** — 13 reads + 9 writes. Reads are always available when the
`data.postgres` tier is present; writes require an explicit `confirm` argument
matching the target name.

### Reads

| Group | Tools |
| --- | --- |
| Inventory & info | `pg_list`, `pg_info`, `pg_plans` |
| Credentials | `pg_credentials_list`, `pg_credentials_url` *(sensitive)* |
| Backups | `pg_backups_list`, `pg_backups_info`, `pg_backups_url` *(sensitive)*, `pg_backups_schedules` |
| Followers | `pg_followers_list`, `pg_leader`, `pg_replication_status` |
| Config | `pg_maintenance_window` |

### Writes (require `confirm`)

| Group | Tools |
| --- | --- |
| Connections | `pg_connection_reset` |
| Credentials | `pg_credentials_create`, `pg_credentials_destroy`, `pg_credentials_rotate`, `pg_credentials_repair_default` |
| Backups | `pg_backups_capture`, `pg_backups_delete`, `pg_backups_schedule` |
| Config | `pg_maintenance_window_set` |

### Deferred / out of scope

- `pg_diagnostics` — requires a separate diagnostics service (`PGDIAGNOSE_HOST`); the Data API endpoint returns 404. Deferred.
- `pg_connection_pooling` — no read endpoint exists yet. Deferred.
- `pg_query_insights` — requires a direct database connection (`pg_stat_statements`); there is no HTTP API. Out of scope for a pure-HTTPS server.

## Endpoints & auth

Postgres operations span two hosts, both authenticated with the same Heroku
OAuth bearer token the core client already carries:

- **Platform API** (`api.heroku.com`) — `pg_list` (app add-ons) and `pg_plans` (plan catalog).
- **Heroku Data API** (`api.data.heroku.com/client/v11/...`) — everything Postgres-specific (info, credentials, backups, followers, config).

## Capability probing

`POSTGRES_PROBES` (defined in `@heroku-mcp/core`) probe the Data API families at
sign-in time, alongside the Platform matrix. The whole package is gated on the
`data.postgres` root tier; individual families (`pg_backups`, `pg_followers`,
`pg_credentials`) carry their own sub-tier so a tool fails fast with an
actionable message when the family is gated, rather than issuing a request it
knows will fail. A sub-tier that was never probed is treated as available (the
real Heroku response speaks for itself).

## Safety

Every mutating tool requires a `confirm` argument equal to the target name,
enforced by core's `assertConfirm`, and supports `dry_run: true` to preview the
request without executing. The server never auto-fills `confirm`; the AI client
must obtain explicit user acknowledgment.

## Sensitive output

`pg_credentials_url` and `pg_backups_url` return secrets (a connection string
with a password; a signed download URL). The audit log records only the request
URL, which carries no secret — response bodies are never logged.

## Related

- [@heroku-mcp/core](https://www.npmjs.com/package/@heroku-mcp/core) — shared building blocks
- [@heroku-mcp/platform](https://www.npmjs.com/package/@heroku-mcp/platform) — Heroku Platform API tools
- [@heroku-mcp/http-server](https://www.npmjs.com/package/@heroku-mcp/http-server) — the deployable HTTP server that exposes these tools
- [Project documentation](https://github.com/StratisLLC/heroku-platform-mcp-server#readme)

## License

Apache-2.0
