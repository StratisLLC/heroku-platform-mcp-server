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
import { AuthError } from '@heroku-mcp/core';
import type { AppEnv } from '../auth/middleware.js';
import { ReauthRequiredError, resolveUserAccessToken } from '../oauth/flow.js';
import type { HerokuOAuthConfig } from '../oauth/heroku.js';
import { buildSessionMcp } from '../mcp/setup.js';
import { dbAuditSink } from '../mcp/audit-wrapper.js';
import { generateSessionId, type TransportManager } from '../mcp/transport.js';
import type { Config } from '../config.js';
import type { WebSocketFactory } from '../mcp/dynos-run.js';
import { appendAuditEntry } from '../db/repos/audit-log.js';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';

export interface McpRouteDeps {
  pool: pg.Pool;
  cfg: Config;
  oauthCfg: HerokuOAuthConfig;
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
    if (auth?.kind !== 'bearer' && auth?.kind !== 'oauth') {
      return c.json({ ok: false, error: { kind: 'auth', message: 'bearer required' } }, 401);
    }
    if (auth.kind === 'bearer' && !auth.connectionToken) {
      return c.json({ ok: false, error: { kind: 'auth', message: 'bearer required' } }, 401);
    }
    if (auth.kind === 'oauth' && !auth.oauthToken) {
      return c.json({ ok: false, error: { kind: 'auth', message: 'bearer required' } }, 401);
    }
    const tokenFingerprint =
      auth.kind === 'bearer'
        ? auth.connectionToken!.id.slice(0, 16)
        : auth.oauthToken!.clientId.slice(0, 16);
    const connectionTokenId = auth.kind === 'bearer' ? auth.connectionToken!.id : null;
    const oauthClientId = auth.kind === 'oauth' ? auth.oauthToken!.clientId : null;

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
      // Build a per-request token getter. `resolveUserAccessToken` checks
      // expiry and refreshes via the stored refresh token when needed, so
      // calling it on every Heroku request keeps a long-lived MCP session
      // alive past the ~8h access-token TTL. ReauthRequiredError from
      // mid-session calls is wrapped into a core AuthError so the tool
      // envelope renders as kind:'auth' with code:'reauth_required' (rather
      // than the generic kind:'server' that a bare Error would produce).
      const userId = auth.user.id;
      const signInUrl = `${deps.cfg.publicUrl}/sign-in`;
      const getAccessToken = async (): Promise<string> => {
        try {
          return await resolveUserAccessToken(
            deps.pool,
            userId,
            deps.cfg.masterKey,
            deps.oauthCfg,
          );
        } catch (err) {
          if (err instanceof ReauthRequiredError) {
            throw new AuthError(err.message, {
              details: { code: err.code, signInUrl },
              cause: err,
            });
          }
          throw err;
        }
      };

      // Fail-fast at session creation: a user whose refresh token is dead
      // should get a clean HTTP 401 envelope from initialize, not a session
      // that succeeds and then collapses on the first tool call. Resolving
      // once here also warms the row (subsequent getter calls within ~8h
      // return the cached fresh token without refreshing again).
      try {
        await resolveUserAccessToken(
          deps.pool,
          auth.user.id,
          deps.cfg.masterKey,
          deps.oauthCfg,
        );
      } catch (err) {
        if (err instanceof ReauthRequiredError) {
          return c.json(
            {
              ok: false,
              error: {
                kind: 'auth',
                code: err.code,
                message: err.message,
                signInUrl,
              },
            },
            401,
          );
        }
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
        getAccessToken,
        tokenFingerprint,
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
          connectionTokenId,
          oauthClientId,
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
        details:
          auth.kind === 'bearer'
            ? { connection_token_id: auth.connectionToken!.id }
            : { oauth_client_id: auth.oauthToken!.clientId },
      }).catch(() => undefined);
    }

    // Dispatch to the transport. `@hono/node-server` exposes the raw Node
    // req/res on `c.env`.
    const env = c.env as { incoming: IncomingMessage; outgoing: ServerResponse };
    await session.transport.handleRequest(env.incoming, env.outgoing, body);
    return RESPONSE_ALREADY_SENT;
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
