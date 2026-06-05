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
  PLATFORM_PROBES,
  RateLimitTracker,
  SchemaCache,
  createClient,
  type CapabilityResult,
  type HerokuClient,
  type Probe,
} from '@heroku-mcp/core';
import { loadOrProbe } from './capabilities.js';
import type { ToolContext } from './context.js';
import { fingerprintToken } from './fingerprint.js';
import { resolvePaths, type ResolvedPaths } from './paths.js';
import { registerAllTools, type RegistrationSummary } from './tools/index.js';

/** Inputs to {@link buildServer}. Only `token` is required at runtime; tests
 *  inject everything else. */
export interface BuildServerOptions {
  /** Bearer token to send on Heroku requests. May be a string (static) or a
   *  thunk that returns the current token (HTTP server with refresh). */
  token: string | (() => Promise<string> | string);
  /** Override resolved paths (tests). */
  paths?: ResolvedPaths;
  /** Override the HTTP fetch (tests). */
  fetch?: typeof globalThis.fetch;
  /** Override the version reported in the User-Agent and `serverInfo`. */
  version?: string;
  /** Force a refresh of the capability cache at startup. */
  forceProbe?: boolean;
  /** Optional hook fired after the McpServer is constructed but BEFORE any
   *  tool is registered. Lets callers wrap `server.registerTool` with
   *  observability/audit logic or substitute tool handlers. */
  beforeRegisterTools?: (server: McpServer, ctx: ToolContext) => void;
  /** Override the server name reported in `serverInfo`. Defaults to
   *  `"herokumcp-platform"`. */
  serverName?: string;
  /** Override the User-Agent suffix in parentheses. Defaults to `"platform"`. */
  userAgentSuffix?: string;
  /** Override the token fingerprint used in audit lines. Defaults to
   *  SHA-256(token)[:16]. Pass an explicit value when the token is opaque to
   *  the caller (e.g. HTTP server: the connection token id). */
  tokenFingerprint?: string;
  /** Extra capability probes to run alongside the Platform API matrix. Used by
   *  the HTTP server to light up sibling product tiers (e.g. Postgres MCP) at
   *  sign-in time so their tool families are gated by the same one-shot probe
   *  pass. Defaults to none — stdio runs probe only the Platform matrix. */
  extraProbes?: readonly Probe[];
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
  const serverName = opts.serverName ?? PACKAGE_NAME;
  const userAgentSuffix = opts.userAgentSuffix ?? 'platform';
  const userAgent = `herokumcp/${version} (${userAgentSuffix})`;

  const tokenProvider: () => Promise<string> | string =
    typeof opts.token === 'function' ? opts.token : () => opts.token as string;

  // For probing we need a sync-or-async token; we resolve it once at startup.
  const initialToken = await Promise.resolve(tokenProvider());
  const tokenFingerprint = opts.tokenFingerprint ?? fingerprintToken(initialToken);

  // Core primitives.
  const etagCache = new ETagCache();
  const rateLimit = new RateLimitTracker();
  const audit = new AuditLogger({ dir: paths.auditDir });
  const schema = new SchemaCache({ path: paths.schemaCachePath });

  const client: HerokuClient = createClient({
    token: tokenProvider,
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
    token: initialToken,
    userAgent,
    ...(opts.extraProbes && opts.extraProbes.length > 0
      ? { probes: [...PLATFORM_PROBES, ...opts.extraProbes] }
      : {}),
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
    token: tokenProvider,
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
    { name: serverName, version },
    { capabilities: { tools: { listChanged: true } } },
  );

  if (opts.beforeRegisterTools) {
    opts.beforeRegisterTools(server, context);
  }

  const registration = registerAllTools(server, context);
  return { server, context, registration, capabilities };
}
