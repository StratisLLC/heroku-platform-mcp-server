/**
 * Per-session MCP server construction for the HTTP transport.
 *
 * Each Streamable HTTP MCP session gets its own McpServer wired with:
 *   - a HerokuClient bound to the authenticated user's access token
 *   - a tool-call audit wrapper that writes rows into `audit_log`
 *   - the buffered `dynos_run` substitute (DECISION 8)
 *
 * The layering of registerTool wrappers (audit + dynos_run skip) is done with
 * explicit captures so we can rewind only the dynos_run skip after platform-
 * mcp's bulk registration completes.
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  buildServer,
  resolvePaths,
  type BuiltServer,
  type ToolContext,
} from '@heroku-mcp/platform';
import { POSTGRES_PROBES, registerPostgresTools } from '@heroku-mcp/postgres';
import { installAuditWrapper, type AuditSink } from './audit-wrapper.js';
import { registerDynosRunBuffered, type WebSocketFactory } from './dynos-run.js';

export interface SessionMcpOptions {
  /** Lazy provider for the user's Heroku access token. Invoked once per
   *  outgoing Heroku request by the core client, so a stale token can be
   *  refreshed mid-session without rebuilding the session. The getter is also
   *  invoked once during session construction (capability probing). May throw
   *  to abort the request — see {@link ReauthRequiredError}. */
  getAccessToken: () => Promise<string>;
  /** Stable identifier for audit lines — use the connection-token id. */
  tokenFingerprint: string;
  /** Audit sink for tool-call events. */
  auditSink: AuditSink;
  /** Per-request context the audit wrapper writes alongside each row. */
  getAuditContext: () => {
    userId: string;
    clientName: string | null;
    clientVersion: string | null;
  };
  /** Optional version string for serverInfo. */
  version?: string;
  /** Inject a fetch (tests). */
  fetch?: typeof globalThis.fetch;
  /** Inject a WebSocket factory (tests). */
  webSocketFactory?: WebSocketFactory;
}

/** Build an McpServer ready to connect to a StreamableHTTPServerTransport. */
export async function buildSessionMcp(opts: SessionMcpOptions): Promise<BuiltServer> {
  // The per-session HEROKUMCP_HOME holds capability-cache + JSONL audit dir.
  const home = await mkdtemp(join(tmpdir(), 'hmcp-http-'));
  const paths = resolvePaths({ home, platform: 'linux' });

  // We'll capture the audit-wrapped registerTool here so we can re-install it
  // (without the dynos_run skip) after registerAllTools completes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let auditWrappedRegisterTool: ((name: string, cfg: any, handler: any) => any) | null = null;

  const built = await buildServer({
    token: opts.getAccessToken,
    tokenFingerprint: opts.tokenFingerprint,
    paths,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    serverName: 'herokumcp-platform-http',
    userAgentSuffix: 'platform-http',
    ...(opts.version !== undefined ? { version: opts.version } : {}),
    forceProbe: false,
    // Probe the Postgres-specific Data API families alongside the Platform
    // matrix so the sibling @heroku-mcp/postgres tools are gated by the same
    // one-shot probe pass at session sign-in.
    extraProbes: POSTGRES_PROBES,
    beforeRegisterTools: (server: McpServer, _ctx: ToolContext) => {
      // Layer 1: audit wrapper. Captures the previously-installed registerTool
      // (the SDK's default) and installs a wrapped version.
      installAuditWrapper(server, opts.auditSink, () => {
        const c = opts.getAuditContext();
        return {
          userId: c.userId,
          clientName: c.clientName,
          clientVersion: c.clientVersion,
        };
      });
      // Snapshot the audit-wrapped registerTool so we can restore it later
      // (the dynos_run skip layer below overwrites it again).
      /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
      auditWrappedRegisterTool = (server as any).registerTool.bind(server) as (
        name: string,
        cfg: any,
        handler: any,
      ) => unknown;

      // Layer 2: dynos_run skip. Intercept just the one name and drop it on
      // the floor so platform-mcp's stub does not register.
      const wrapped = (server as any).registerTool.bind(server) as (
        name: string,
        cfg: any,
        handler: any,
      ) => unknown;
      (server as any).registerTool = (name: string, cfg: any, handler: any): unknown => {
        if (name === 'dynos_run') return undefined;
        return wrapped(name, cfg, handler);
      };
      /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
    },
  });

  // Restore the audit-wrapped registerTool (without the dynos_run skip) so the
  // buffered registration below succeeds.
  if (auditWrappedRegisterTool !== null) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (built.server as any).registerTool = auditWrappedRegisterTool;
  }
  registerDynosRunBuffered(
    built.server,
    built.context,
    opts.webSocketFactory ? { webSocketFactory: opts.webSocketFactory } : {},
  );
  // Register the sibling Postgres MCP tools onto the same server + context so
  // the merged catalog exposes Platform and Postgres tools as one surface. Uses
  // the (restored) audit-wrapped registerTool, so Postgres tool calls audit too.
  registerPostgresTools(built.server, built.context);
  return built;
}
