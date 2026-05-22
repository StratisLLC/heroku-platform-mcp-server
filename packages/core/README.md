# @heroku-mcp/core

Shared library for [`heroku-platform-mcp`](../platform-mcp) and [`heroku-partner-mcp`](../partner-mcp).

Exports:

- **errors** — typed Heroku error hierarchy and `kind` enum for tool responses
- **redact** — secret redaction for logs, audit lines, and bubbled error payloads
- **ratelimit** — `RateLimit-Remaining` tracker that switches the client to a serial queue at low budget
- **etag** — `If-None-Match` / 304 cache for idempotent GETs
- **pagination** — `Range` / `Next-Range` cursor helpers
- **audit** — JSONL audit log with daily rotation
- **tokens** — keychain / encrypted-file / in-memory token storage
- **client** — the HTTP client that ties the above together
- **schema** — Heroku JSON schema fetch + cache
- **probes** + **prober** — startup capability probing (see [CAPABILITY_PROBES.md](../../CAPABILITY_PROBES.md))

See [ARCHITECTURE.md §4](../../ARCHITECTURE.md#4-repository-layout) and §7 for context.

## License

[Apache-2.0](../../LICENSE).
