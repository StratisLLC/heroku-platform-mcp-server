/**
 * Library entry for `@heroku-mcp/platform`. Re-exports the wiring needed by
 * out-of-tree consumers (notably `@heroku-mcp/http-server`, which uses the
 * same registration plumbing under a Streamable HTTP transport).
 */

export { buildServer } from './server.js';
export type { BuildServerOptions, BuiltServer } from './server.js';
export type { ToolContext, RefreshCapabilities } from './context.js';
export { resolvePaths } from './paths.js';
export type { ResolvedPaths, ResolvePathsInput } from './paths.js';
export { registerAllTools } from './tools/index.js';
export type { RegistrationSummary } from './tools/index.js';
export { fingerprintToken, TOKEN_FINGERPRINT_LENGTH } from './fingerprint.js';
export { isDiagnosticOnly, tierAvailable, loadOrProbe } from './capabilities.js';
export type { LoadOrProbeOptions, LoadOrProbeResult } from './capabilities.js';
export { envelopeFromClientSuccess, envelopeFromLocal, toolContent } from './envelope.js';
export type { ToolEnvelope, ToolSuccessEnvelope, SuccessMeta } from './envelope.js';
export { runTool, ok, paginationInputShape, rangeHeader } from './tool-helpers.js';
export type { ToolResult, HerokuRecord, HerokuList } from './tool-helpers.js';
