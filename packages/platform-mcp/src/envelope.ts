/**
 * Tool-response envelope.
 *
 * The implementation moved to `@heroku-mcp/core` in Phase 8a (so every MCP
 * package shares one source of truth). This module re-exports it to preserve
 * `@heroku-mcp/platform`'s public surface and the internal `./envelope.js`
 * import paths used across the platform tools.
 */

export { envelopeFromClientSuccess, envelopeFromLocal, toolContent } from '@heroku-mcp/core';
export type { ToolEnvelope, ToolSuccessEnvelope, SuccessMeta } from '@heroku-mcp/core';
