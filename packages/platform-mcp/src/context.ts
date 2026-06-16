/**
 * Server-wide context passed to every tool handler.
 *
 * The {@link ToolContext} type moved to `@heroku-mcp/core` in Phase 8a (so
 * every MCP package shares one source of truth). This module re-exports it to
 * preserve `@heroku-mcp/platform`'s public surface and the internal
 * `./context.js` import paths used across the platform tools.
 */

export type { ToolContext, RefreshCapabilities } from '@heroku-mcp/core';
