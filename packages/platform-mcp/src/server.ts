/**
 * Server bootstrap. Wires up the core HTTP client, audit log, schema cache,
 * and capability probing, then registers the tool set the probes authorise.
 *
 * Split from `index-stdio.ts` so unit tests can construct a server without a
 * stdio transport.
 */

import { mkdir } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  AuditLogger,
  ETagCache,
  RateLimitTracker,
  SchemaCache,
  createClient,
  type CapabilityResult,
  type HerokuClient,
} from '@heroku-mcp/core';
import { loadOrProbe } from './capabilities.js';
import type { ToolContext } from './context.js';
import { fingerprintToken } from './fingerprint.js';
import { resolvePaths, type ResolvedPaths } from './paths.js';
import { registerAllTools, type RegistrationSummary } from './tools/index.js';

/** Inputs to {@link buildServer}. Only `token` is required at runtime; tests
 *  inject everything else. */
export interface BuildServerOptions {
  /** Bearer token to send on Heroku requests. */
  token: string;
  /** Override resolved paths (tests). */
  paths?: ResolvedPaths;
  /** Override the HTTP fetch (tests). */
  fetch?: typeof globalThis.fetch;
  /** Override the version reported in the User-Agent and `serverInfo`. */
  version?: string;
  /** Force a refresh of the capability cache at startup. */
  forceProbe?: boolean;
}

/** Whatever the entrypoint needs to plug a transport into. */
export interface BuiltServer {
  server: McpServer;
  context: ToolContext;
  registration: RegistrationSummary;
  capabilities: CapabilityResult;
}

const PACKAGE_NAME = 'herokumcp-platform';

/** Construct a fully-wired {@link McpServer}. The caller is responsible for
 *  attaching a transport via `server.connect(...)`. */
export async function buildServer(opts: BuildServerOptions): Promise<BuiltServer> {
  const paths = opts.paths ?? resolvePaths();
  await mkdir(paths.home, { recursive: true });
  const version = opts.version ?? '0.0.0';
  const userAgent = `herokumcp/${version} (platform)`;
  const tokenFingerprint = fingerprintToken(opts.token);

  // Core primitives.
  const etagCache = new ETagCache();
  const rateLimit = new RateLimitTracker();
  const audit = new AuditLogger({ dir: paths.auditDir });
  const schema = new SchemaCache({ path: paths.schemaCachePath });

  const client: HerokuClient = createClient({
    token: () => opts.token,
    tokenFingerprint,
    server: 'platform',
    userAgent,
    etagCache,
    rateLimit,
    audit,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  // Capability probing.
  const probeOptions = {
    token: opts.token,
    userAgent,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  };

  let probeResult = await loadOrProbe({
    filePath: paths.capabilityFile(tokenFingerprint),
    tokenFingerprint,
    probeOptions,
    ...(opts.forceProbe !== undefined ? { force: opts.forceProbe } : {}),
  });

  // Shared, mutable capability snapshot. `refreshCapabilities` mutates the
  // pointer so tool handlers always see the most recent matrix without
  // having to import a state container.
  let capabilities = probeResult.capabilities;

  const context: ToolContext = {
    client,
    audit,
    paths,
    schema,
    tokenFingerprint,
    userAgent,
    getCapabilities: () => capabilities,
    refreshCapabilities: async ({ force = true } = {}) => {
      probeResult = await loadOrProbe({
        filePath: paths.capabilityFile(tokenFingerprint),
        tokenFingerprint,
        probeOptions,
        force,
      });
      capabilities = probeResult.capabilities;
      return capabilities;
    },
  };

  const server = new McpServer(
    { name: PACKAGE_NAME, version },
    { capabilities: { tools: { listChanged: true } } },
  );

  const registration = registerAllTools(server, context);
  return { server, context, registration, capabilities };
}
