# @heroku-mcp/postgres

Heroku Postgres tools for the Heroku MCP server. Sibling of
[`@heroku-mcp/platform`](../platform-mcp). This package is a library: the hosted
HTTP server registers its tools alongside the Platform tools so connecting
clients (e.g. Claude Desktop) see one merged catalog.

## Phase 6 Part A — reads + probing

Read-only tools only. Writes (destroy, rotate, fork/copy, upgrade, backup
capture/restore) land in Part B behind the confirm pattern.

| Group | Tools |
| --- | --- |
| Inventory & info | `pg_list`, `pg_info`, `pg_plans`, `pg_credentials_list`, `pg_credentials_url` |
| Backups | `pg_backups_list`, `pg_backups_info`, `pg_backups_url`, `pg_backups_schedules` |
| Followers | `pg_followers_list`, `pg_leader`, `pg_replication_status` |
| Config & monitoring | `pg_maintenance_window`, `pg_connection_pooling`, `pg_diagnostics`, `pg_query_insights` |

## Endpoints & auth

Postgres operations span two hosts, both authenticated with the same Heroku
OAuth bearer token the core client already carries:

- **Platform API** (`api.heroku.com`) — `pg_list` (app add-ons) and `pg_plans`
  (plan catalog).
- **Heroku Data API** (`api.data.heroku.com/client/v11/...`) — everything
  Postgres-specific (info, credentials, backups, followers, config, insights).

## Capability probing

`POSTGRES_PROBES` (defined in `@heroku-mcp/core`) probe the Data API families at
sign-in time, alongside the Platform matrix. The whole package is gated on the
`data.postgres` root tier; individual families (`pg_backups`, `pg_followers`,
`pg_credentials`, `pg_query_insights`) carry their own sub-tier so a tool fails
fast with an actionable message when the family is gated, rather than issuing a
request it knows will fail. A sub-tier that was never probed is treated as
available (the real Heroku response speaks for itself).

## Sensitive output

`pg_credentials_url` and `pg_backups_url` return secrets (a connection string
with a password; a signed download URL). Never log the response body — the audit
log records only the request URL, which carries no secret.
