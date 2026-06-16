/**
 * Per-session construction for `/mcp-codemode` (Phase 9).
 *
 * Builds TWO servers per session:
 *   1. The FULL server — exactly the same {@link buildSessionMcp} a `/mcp`
 *      session uses (all authorised tools, audit-wrapped, sharing one
 *      ToolContext). It is NOT connected to a transport; it serves only as the
 *      catalog source and `execute` dispatch target.
 *   2. The META server — a fresh McpServer advertising only `search`,
 *      `execute`, `auth_status`. THIS is connected to the transport.
 *
 * Because `execute` dispatches to the full server's audit-wrapped handlers,
 * Code Mode is a discovery layer, not a new execution path (Phase 9 decision).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BuiltServer } from '@heroku-mcp/platform';
import { buildSessionMcp, type SessionMcpOptions } from '../mcp/setup.js';
import { ToolCatalog, collectRegisteredTools } from './index.js';
import { buildDispatchMap, registerCodemodeMetaTools, type CodemodeContext } from './meta-tools.js';

export interface CodemodeSessionOptions extends SessionMcpOptions {
  /** Authenticated user's email, surfaced by `auth_status`. */
  email: string;
}

export interface BuiltCodemodeSession {
  /** The meta server — connect this to the StreamableHTTP transport. */
  metaServer: McpServer;
  /** The full server — close this when the session ends. */
  full: BuiltServer;
  /** The session's tool catalog (for diagnostics / benchmarking). */
  catalog: ToolCatalog;
}

/** Build a Code Mode session: full server + 3-tool meta server. */
export async function buildCodemodeSession(
  opts: CodemodeSessionOptions,
): Promise<BuiltCodemodeSession> {
  const { email, ...sessionOpts } = opts;

  // 1. The full catalog, gated + audit-wrapped exactly like /mcp.
  const full = await buildSessionMcp(sessionOpts);

  // 2. Index + dispatch table off the full server's registered tools.
  const collected = collectRegisteredTools(full.server);
  const catalog = new ToolCatalog(
    [...collected.entries()].map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  );
  const dispatch = buildDispatchMap(collected);

  const ctx: CodemodeContext = {
    catalog,
    dispatch,
    identity: { email },
    client: full.context.client,
    getCapabilities: full.context.getCapabilities,
  };

  // 3. The 3-tool meta server (NOT audit-wrapped — execute delegates to the
  //    already-audited full handlers).
  const metaServer = new McpServer(
    { name: 'herokumcp-codemode-http', version: opts.version ?? '0.0.0' },
    { capabilities: { tools: { listChanged: true } } },
  );
  registerCodemodeMetaTools(metaServer, ctx);

  return { metaServer, full, catalog };
}
