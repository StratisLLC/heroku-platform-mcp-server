/**
 * /mcp — the Streamable HTTP MCP endpoint.
 *
 * Authentication is bearer (Authorization: Bearer hmcp_...). On the first
 * initialize, we build a per-session McpServer, register it with the
 * TransportManager, and dispatch the request. Subsequent requests with a
 * matching Mcp-Session-Id reuse the existing session.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Hono } from 'hono';
import type pg from 'pg';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { AppEnv } from '../auth/middleware.js';
import { resolveUserAccessToken } from '../oauth/flow.js';
import { buildSessionMcp } from '../mcp/setup.js';
import { dbAuditSink } from '../mcp/audit-wrapper.js';
import { generateSessionId, type TransportManager } from '../mcp/transport.js';
import type { Config } from '../config.js';
import type { WebSocketFactory } from '../mcp/dynos-run.js';
import { appendAuditEntry } from '../db/repos/audit-log.js';

export interface McpRouteDeps {
  pool: pg.Pool;
  cfg: Config;
  transports: TransportManager;
  /** Optional injection point for tests (mocked Heroku fetch + WS). */
  fetch?: typeof globalThis.fetch;
  webSocketFactory?: WebSocketFactory;
  /** Version string surfaced in serverInfo. */
  version?: string;
}

export function buildMcpRoutes(deps: McpRouteDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // The MCP transport speaks both POST (requests, batched messages) and GET
  // (streaming notifications). We mount a single handler on /mcp that
  // multiplexes by method.
  router.all('/mcp', async (c) => {
    const auth = c.get('auth');
    if (auth?.kind !== 'bearer' || !auth.connectionToken) {
      return c.json({ ok: false, error: { kind: 'auth', message: 'bearer required' } }, 401);
    }

    const sessionIdHeader = c.req.header('mcp-session-id');
    let session = deps.transports.get(sessionIdHeader);
    const method = c.req.method;

    // Parse the request body up-front for POSTs so we can decide whether this
    // is an initialize request.
    let body: unknown;
    if (method === 'POST') {
      try {
        body = await c.req.json();
      } catch {
        body = undefined;
      }
    }

    const isInit = body !== undefined && isInitializeRequest(body);

    if (!session) {
      if (method !== 'POST' || !isInit) {
        return c.json(
          { ok: false, error: { kind: 'session', message: 'no active MCP session' } },
          400,
        );
      }
      // Decrypt this user's Heroku access token. If decryption fails, the
      // server's master key probably doesn't match what encrypted the row.
      let accessToken: string;
      try {
        accessToken = await resolveUserAccessToken(deps.pool, auth.user.id, deps.cfg.masterKey);
      } catch (err) {
        return c.json(
          {
            ok: false,
            error: {
              kind: 'auth',
              message: 'Could not decrypt your Heroku tokens. Sign in again at /sign-in.',
              details: { err: err instanceof Error ? err.message : String(err) },
            },
          },
          401,
        );
      }

      const sessionId = generateSessionId();
      const built = await buildSessionMcp({
        accessToken,
        tokenFingerprint: auth.connectionToken.id.slice(0, 16),
        auditSink: dbAuditSink(deps.pool),
        getAuditContext: () => ({
          userId: auth.user.id,
          clientName: clientNameFor(sessionId, deps.transports),
          clientVersion: clientVersionFor(sessionId, deps.transports),
        }),
        ...(deps.version !== undefined ? { version: deps.version } : {}),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.webSocketFactory ? { webSocketFactory: deps.webSocketFactory } : {}),
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      await built.server.connect(transport as any);

      session = deps.transports.register(
        {
          userId: auth.user.id,
          connectionTokenId: auth.connectionToken.id,
          built,
          transport,
          clientName: null,
          clientVersion: null,
        },
        sessionId,
      );

      transport.onclose = (): void => {
        deps.transports.remove(sessionId);
      };

      // Try to extract client name/version from the initialize body so we can
      // record it for audit purposes.
      try {
        const init = body as { params?: { clientInfo?: { name?: string; version?: string } } };
        const info = init.params?.clientInfo;
        if (info?.name) session.clientName = info.name;
        if (info?.version) session.clientVersion = info.version;
      } catch {
        // ignore — clientInfo is advisory
      }

      await appendAuditEntry(deps.pool, {
        userId: auth.user.id,
        category: 'system',
        eventName: 'mcp_session_start',
        status: 'ok',
        clientName: session.clientName,
        clientVersion: session.clientVersion,
        details: { connection_token_id: auth.connectionToken.id },
      }).catch(() => undefined);
    }

    // Dispatch to the transport. `@hono/node-server` exposes the raw Node
    // req/res on `c.env`.
    const env = c.env as { incoming: IncomingMessage; outgoing: ServerResponse };
    await session.transport.handleRequest(env.incoming, env.outgoing, body);
    return undefined;
  });

  return router;
}

function clientNameFor(sessionId: string, tm: TransportManager): string | null {
  const s = tm.get(sessionId);
  return s?.clientName ?? null;
}

function clientVersionFor(sessionId: string, tm: TransportManager): string | null {
  const s = tm.get(sessionId);
  return s?.clientVersion ?? null;
}
