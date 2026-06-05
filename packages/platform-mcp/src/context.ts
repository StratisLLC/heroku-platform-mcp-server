/**
 * Server-wide context passed to every tool handler.
 *
 * Tools never reach into `process.env` or instantiate their own clients —
 * everything they need (HTTP client, audit logger, capability snapshot,
 * config paths) flows through the {@link ToolContext} they receive at
 * registration time. This makes them trivial to unit-test against fakes.
 */

import type { AuditLogger, CapabilityResult, HerokuClient, SchemaCache } from '@heroku-mcp/core';
import type { ResolvedPaths } from './paths.js';

/** Refresh the cached capabilities by re-running probes; tools use this when
 *  the host invokes `refresh_capabilities`. */
export type RefreshCapabilities = (opts?: { force?: boolean }) => Promise<CapabilityResult>;

export interface ToolContext {
  /** HTTP client wired to api.heroku.com. */
  client: HerokuClient;
  /** Lazy provider for the raw Heroku OAuth token. Most tools never need this —
   *  the {@link client} attaches the Bearer header itself. It exists for the few
   *  endpoints that require a different auth construction from the same token,
   *  notably the Heroku Data API's `/postgres/v0/*` namespace, which takes HTTP
   *  Basic auth (`Basic base64(":" + token)`). Treat the returned value as a
   *  secret: never log it. */
  token: () => Promise<string> | string;
  /** Audit logger for mutating tools (Phase 1 has none, but the wiring is in
   *  place so Phase 2 can drop in writes without changing this surface). */
  audit: AuditLogger;
  /** Snapshot of the capability probe matrix. Refreshed when the host calls
   *  `refresh_capabilities`. Use the {@link refresh} callback to mutate the
   *  snapshot in lock-step with the on-disk file. */
  getCapabilities: () => CapabilityResult;
  /** Re-run probes, persist the result, and update the in-memory snapshot. */
  refreshCapabilities: RefreshCapabilities;
  /** First 16 chars of SHA-256(token). Used in audit lines and exposed via
   *  `whoami` for support-ticket cross-reference. */
  tokenFingerprint: string;
  /** Pre-computed paths for capability cache, audit log, schema cache. */
  paths: ResolvedPaths;
  /** Schema cache; `schema_info` reads its metadata. */
  schema: SchemaCache;
  /** User-Agent string the client uses; surfaced for diagnostics. */
  userAgent: string;
}
