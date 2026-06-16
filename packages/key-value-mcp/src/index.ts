/**
 * `@heroku-mcp/key-value` — Heroku Key-Value Store (Redis) MCP tools (Part A:
 * admin/control-plane reads, writes + capability probing).
 *
 * This package is a library, not a standalone server. The hosted HTTP server
 * (`@heroku-mcp/http-server`) imports {@link registerKeyValueTools} and calls
 * it against the same per-session `McpServer` and `ToolContext` it builds for
 * `@heroku-mcp/platform` and `@heroku-mcp/postgres`, so the user sees one
 * merged tool catalog.
 *
 * Capability probing for the Key-Value-specific endpoint families is wired
 * through the Platform server's `extraProbes` option using {@link KEYVALUE_PROBES}.
 *
 * Scope note: Part A ships admin/control-plane tools only. Redis-protocol data
 * operations (GET/SET/KEYS/…), `kv_upgrade`, `kv_promote`, and `kv_wait` are
 * deliberately NOT implemented here.
 */

export { registerKeyValueTools } from './tools/index.js';
export type { KeyValueRegistrationSummary } from './tools/index.js';
export { KEYVALUE_PROBES, KV_FAMILY_TIERS, KV_PROBE_IDS } from './probes.js';
export { maskRedisUrl } from './tools/credentials.js';
export type { MaskedRedisUrl } from './tools/credentials.js';
export { redactKvInfo } from './tools/inventory.js';
export { DATA_API_BASE, REDIS_V0_PREFIX, redisV0Url } from './client.js';
export type { KvFamily } from './client.js';
