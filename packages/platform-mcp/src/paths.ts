/**
 * Filesystem path resolution.
 *
 * The implementation moved to `@heroku-mcp/core` in Phase 8a (so every MCP
 * package shares one source of truth). This module re-exports it to preserve
 * `@heroku-mcp/platform`'s public surface and the internal `./paths.js` import
 * paths used by the server bootstrap.
 */

export { resolvePaths } from '@heroku-mcp/core';
export type { ResolvedPaths, ResolvePathsInput } from '@heroku-mcp/core';
