/**
 * /mcp-codemode — the token-optimised Streamable HTTP MCP endpoint (Phase 9).
 *
 * Protocol-, transport-, session- and auth-handling are IDENTICAL to /mcp
 * (see routes/mcp.ts). The only difference is the server connected to the
 * transport: a 3-tool "meta" server (`search`, `execute`, `auth_status`)
 * instead of the full 276-tool catalog. The full catalog is still built
 * server-side and reachable through `execute`'s dispatch.
 *
 * The auth/token/session boilerplate is deliberately duplicated from
 * routes/mcp.ts rather than refactored into a shared helper: /mcp is the live,
 * shipped 1.0.0 endpoint and must stay byte-for-byte unchanged. Keep the two
 * handlers in sync if the session lifecycle ever changes.
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
import { dbAuditSink } from '../mcp/audit-wrapper.js';
import { generateSessionId, type TransportManager } from '../mcp/transport.js';
import type { Config } from '../config.js';
import type { WebSocketFactory } from '../mcp/dynos-run.js';
import { appendAuditEntry } from '../db/repos/audit-log.js';
import { buildCodemodeSession } from '../codemode/session.js';
import { logAuthDebug } from '../auth/debug.js';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';

export interface CodemodeRouteDeps {
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

export function buildCodemodeRoutes(deps: CodemodeRouteDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.all('/mcp-codemode', async (c) => {
    const auth = c.get('auth');
    if (auth?.kind !== 'bearer' && auth?.kind !== 'oauth') {
      logAuthDebug('codemode_reject', {
        status: '401',
        branch: 'principal_kind',
        resource: '/mcp-codemode',
      });
      return c.json({ ok: false, error: { kind: 'auth', message: 'bearer required' } }, 401);
    }
    let tokenFingerprint: string;
    let connectionTokenId: string | null = null;
    let oauthClientId: string | null = null;
    if (auth.kind === 'bearer') {
      if (!auth.connectionToken) {
        logAuthDebug('codemode_reject', {
          status: '401',
          branch: 'bearer_principal_missing_token',
          resource: '/mcp-codemode',
        });
        return c.json({ ok: false, error: { kind: 'auth', message: 'bearer required' } }, 401);
      }
      tokenFingerprint = auth.connectionToken.id.slice(0, 16);
      connectionTokenId = auth.connectionToken.id;
    } else {
      if (!auth.oauthToken) {
        logAuthDebug('codemode_reject', {
          status: '401',
          branch: 'oauth_principal_missing_token',
          resource: '/mcp-codemode',
        });
        return c.json({ ok: false, error: { kind: 'auth', message: 'bearer required' } }, 401);
      }
      tokenFingerprint = auth.oauthToken.clientId.slice(0, 16);
      oauthClientId = auth.oauthToken.clientId;
    }

    const sessionIdHeader = c.req.header('mcp-session-id');
    let session = deps.transports.get(sessionIdHeader);
    const method = c.req.method;

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
      const userId = auth.user.id;
      const signInUrl = `${deps.cfg.publicUrl}/sign-in`;
      const getAccessToken = async (): Promise<string> => {
        try {
          return await resolveUserAccessToken(deps.pool, userId, deps.cfg.masterKey, deps.oauthCfg);
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

      // Fail-fast at session creation (mirrors /mcp): dead refresh token → 401
      // envelope from initialize, not a session that collapses on first call.
      try {
        await resolveUserAccessToken(deps.pool, auth.user.id, deps.cfg.masterKey, deps.oauthCfg);
        // A usable upstream Heroku token exists for this session — rules out
        // hypothesis C as the cause of any subsequent 401.
        logAuthDebug('codemode_session_init', {
          status: 'ok',
          upstream_token: 'usable',
          resource: '/mcp-codemode',
        });
      } catch (err) {
        if (err instanceof ReauthRequiredError) {
          // Heroku rejected the stored refresh token — re-auth required.
          logAuthDebug('codemode_reject', {
            status: '401',
            branch: 'session_init',
            reason: 'reauth_required',
            resource: '/mcp-codemode',
          });
          return c.json(
            { ok: false, error: { kind: 'auth', code: err.code, message: err.message, signInUrl } },
            401,
          );
        }
        // Distinguish "no Heroku tokens stored for this user" from a decrypt /
        // other failure — they point at different fixes. The classification is
        // status-only; no token, blob, or secret material is logged.
        const reason =
          err instanceof Error && err.message === 'No stored Heroku tokens for user'
            ? 'no_stored_heroku_token'
            : 'decrypt_or_other_failure';
        logAuthDebug('codemode_reject', {
          status: '401',
          branch: 'session_init',
          reason,
          resource: '/mcp-codemode',
        });
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
      const { metaServer, full } = await buildCodemodeSession({
        getAccessToken,
        tokenFingerprint,
        email: auth.user.email,
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
      // The transport hosts the META server (3 tools). The full server is kept
      // off-transport as the execute() dispatch target.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      await metaServer.connect(transport as any);

      session = deps.transports.register(
        {
          userId: auth.user.id,
          connectionTokenId,
          oauthClientId,
          // Stored so TransportManager eviction closes the full server's
          // resources; the meta server is closed explicitly in onclose below.
          built: full,
          transport,
          clientName: null,
          clientVersion: null,
        },
        sessionId,
      );

      transport.onclose = (): void => {
        deps.transports.remove(sessionId);
        void metaServer.close().catch(() => undefined);
      };

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
            ? { connection_token_id: connectionTokenId, mode: 'codemode' }
            : { oauth_client_id: oauthClientId, mode: 'codemode' },
      }).catch(() => undefined);
    }

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
