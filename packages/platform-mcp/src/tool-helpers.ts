/**
 * Small adapters used by every tool implementation.
 *
 * The implementation moved to `@heroku-mcp/core` in Phase 8a (so every MCP
 * package shares one source of truth). This module re-exports it to preserve
 * `@heroku-mcp/platform`'s public surface and the internal `./tool-helpers.js`
 * import paths used across the platform tools.
 */

export { runTool, ok, rangeHeader, paginationInputShape } from '@heroku-mcp/core';
export type { ToolResult, HerokuRecord, HerokuList } from '@heroku-mcp/core';
