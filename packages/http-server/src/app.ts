/**
 * Hono app construction. Pure factory — no listen() here; that's index.ts.
 *
 * Routing layout:
 *   GET  /                      landing
 *   GET  /health                liveness probe
 *   GET  /sign-in               OAuth initiation
 *   GET  /oauth/callback        OAuth callback
 *   POST /sign-out              clear web session
 *   GET  /me                    self
 *   POST /me/tokens/:id/revoke  revoke one token
 *   POST /me/sign-out-everywhere revoke all tokens
 *   GET  /audit                 self audit
 *   GET  /audit/export          CSV
 *   POST /audit/prune           self-prune
 *   GET  /admin/users           admin-only
 *   POST /admin/users/:id/revoke-all
 *   GET  /admin/tokens
 *   POST /admin/tokens/:id/revoke
 *   GET  /admin/audit
 *   GET  /admin/audit/export
 *   GET  /admin/status
 *   GET  /admin/config
 *   ALL  /mcp                   Streamable HTTP MCP
 */

import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import type pg from 'pg';
import type { Config } from './config.js';
import type { HerokuOAuthConfig } from './oauth/heroku.js';
import {
  bearerAuth,
  requireAdmin,
  webSessionAuth,
  type AppEnv,
  type MiddlewareDeps,
} from './auth/middleware.js';
import { buildPublicRoutes } from './routes/public.js';
import { buildMeRoutes } from './routes/me.js';
import { buildAuditRoutes } from './routes/audit.js';
import { buildAdminRoutes } from './routes/admin.js';
import { buildMcpRoutes } from './routes/mcp.js';
import { buildCodemodeRoutes } from './routes/codemode.js';
import { buildWellKnownRoutes } from './routes/wellknown.js';
import { buildDcrRoutes } from './oauth-provider/dcr.js';
import { publicUrlMiddleware } from './middleware/public-url.js';
import { rateLimit, envInt } from './middleware/rate-limit.js';
import { buildAuthorizeRoutes } from './oauth-provider/authorize.js';
import { buildTokenRoutes } from './oauth-provider/token.js';
import { buildRevokeRoutes } from './oauth-provider/revoke.js';
import type { TransportManager } from './mcp/transport.js';
import type { WebSocketFactory } from './mcp/dynos-run.js';

export interface BuildAppOptions {
  pool: pg.Pool;
  cfg: Config;
  oauthCfg: HerokuOAuthConfig;
  transports: TransportManager;
  /** Per-process map populated by /oauth/callback for one-time token render. */
  pendingTokens?: Map<string, string>;
  /** Test injection points. */
  herokuProbe?: () => Promise<boolean>;
  fetch?: typeof globalThis.fetch;
  webSocketFactory?: WebSocketFactory;
  version?: string;
}

export interface BuiltApp {
  app: Hono<AppEnv>;
  pendingTokens: Map<string, string>;
}

export function buildApp(opts: BuildAppOptions): BuiltApp {
  const pendingTokens = opts.pendingTokens ?? new Map<string, string>();

  const mwDeps: MiddlewareDeps = {
    pool: opts.pool,
    masterKey: opts.cfg.masterKey,
    adminEmails: opts.cfg.adminEmails,
    publicUrlResolver: opts.cfg.publicUrlResolver,
  };

  const app = new Hono<AppEnv>();

  // Security headers on EVERY response (harmless on JSON API responses too).
  // CSP is intentionally left off: the landing/sign-in pages have not been
  // verified under a strict policy, and HSTS + frame-deny + nosniff + referrer
  // already close the review findings. Add CSP only after testing the rendered
  // sign-in page.
  app.use(
    '*',
    secureHeaders({
      strictTransportSecurity: 'max-age=31536000; includeSubDomains',
      xFrameOptions: 'DENY',
      xContentTypeOptions: 'nosniff',
      referrerPolicy: 'strict-origin-when-cross-origin',
    }),
  );

  // FIRST middleware on every request: let the resolver lock in the public URL
  // from this request's Host headers (no-op once resolved). Must run before any
  // handler that reads cfg.publicUrl.
  app.use('*', publicUrlMiddleware(opts.cfg.publicUrlResolver));

  // Top-level web session resolution for all non-/mcp routes.
  app.use('*', async (c, next) => {
    if (
      c.req.path === '/mcp' ||
      c.req.path.startsWith('/mcp/') ||
      c.req.path === '/mcp-codemode' ||
      c.req.path.startsWith('/mcp-codemode/')
    ) {
      // Bearer-only paths — skip session decoding.
      await next();
      return;
    }
    // The wildcard route's Context type is slightly more constrained than the
    // typed-route Context that webSessionAuth was written against — the
    // narrowing is safe here (same shape, just different generic specificity).
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await webSessionAuth(mwDeps)(c, next);
  });

  // OAuth 2.0 discovery documents — mounted before public so they are
  // unauthenticated and not subject to the session-cookie reader (which is
  // harmless but unnecessary).
  app.route('/', buildWellKnownRoutes({ cfg: opts.cfg }));

  // Per-IP rate limits on the intentionally-open OAuth endpoints, to bound
  // registration-spam / token-grinding against the open DCR design. Scoped to
  // these two routes ONLY — /mcp, /oauth/authorize, and the web UI are
  // deliberately untouched. Defaults are operator-tunable via env.
  app.use(
    '/oauth/register',
    rateLimit({
      windowMs: envInt(process.env.HEROKUMCP_RL_REGISTER_WINDOW_MS, 10 * 60 * 1000),
      max: envInt(process.env.HEROKUMCP_RL_REGISTER_MAX, 10),
      keyPrefix: 'register',
    }),
  );
  app.use(
    '/oauth/token',
    rateLimit({
      windowMs: envInt(process.env.HEROKUMCP_RL_TOKEN_WINDOW_MS, 10 * 60 * 1000),
      max: envInt(process.env.HEROKUMCP_RL_TOKEN_MAX, 60),
      keyPrefix: 'token',
    }),
  );

  // OAuth provider routes (DCR, authorize, token, revoke).
  app.route('/', buildDcrRoutes({ pool: opts.pool, cfg: opts.cfg }));
  app.route(
    '/',
    buildAuthorizeRoutes({
      pool: opts.pool,
      cfg: opts.cfg,
      oauthCfg: opts.oauthCfg,
    }),
  );
  app.route('/', buildTokenRoutes({ pool: opts.pool }));
  app.route('/', buildRevokeRoutes({ pool: opts.pool }));

  // Public routes (landing, sign-in, callback, sign-out). Reads `auth` from
  // context but doesn't gate on it.
  app.route(
    '/',
    buildPublicRoutes({
      pool: opts.pool,
      cfg: opts.cfg,
      oauthCfg: opts.oauthCfg,
      transports: opts.transports,
      pendingTokens,
    }),
  );

  // /me and /audit require web auth (the routes redirect to /sign-in if not).
  app.route(
    '/',
    buildMeRoutes({
      pool: opts.pool,
      cfg: opts.cfg,
      pendingTokens,
      transports: opts.transports,
    }),
  );
  app.route('/', buildAuditRoutes({ pool: opts.pool }));

  // /admin/* gated.
  const admin = buildAdminRoutes({
    pool: opts.pool,
    cfg: opts.cfg,
    transports: opts.transports,
    ...(opts.herokuProbe ? { herokuProbe: opts.herokuProbe } : {}),
  });
  app.use('/admin/*', requireAdmin());
  app.route('/', admin);

  // /mcp — Streamable HTTP with bearer auth.
  app.use('/mcp', bearerAuth(mwDeps));
  app.route(
    '/',
    buildMcpRoutes({
      pool: opts.pool,
      cfg: opts.cfg,
      oauthCfg: opts.oauthCfg,
      transports: opts.transports,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.webSocketFactory ? { webSocketFactory: opts.webSocketFactory } : {}),
      ...(opts.version !== undefined ? { version: opts.version } : {}),
    }),
  );

  // /mcp-codemode — token-optimised endpoint (Phase 9). Same bearer auth and
  // transport plumbing; advertises only the 3 Code Mode meta-tools.
  app.use('/mcp-codemode', bearerAuth(mwDeps));
  app.route(
    '/',
    buildCodemodeRoutes({
      pool: opts.pool,
      cfg: opts.cfg,
      oauthCfg: opts.oauthCfg,
      transports: opts.transports,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.webSocketFactory ? { webSocketFactory: opts.webSocketFactory } : {}),
      ...(opts.version !== undefined ? { version: opts.version } : {}),
    }),
  );

  // Centralised error handler — don't leak stack traces in production.
  app.onError((err, c) => {
    const isProd = opts.cfg.isProduction;
    const message = isProd ? 'internal server error' : (err.message ?? 'internal server error');
    // Best-effort system-event log.
    void (async () => {
      try {
        const { appendAuditEntry } = await import('./db/repos/audit-log.js');
        await appendAuditEntry(opts.pool, {
          userId: null,
          category: 'system',
          eventName: 'unhandled_error',
          status: 'error',
          details: {
            path: c.req.path,
            method: c.req.method,
            message: err.message,
          },
        });
      } catch {
        // ignore
      }
    })();
    return c.json({ ok: false, error: { kind: 'server', message } }, 500);
  });

  app.notFound((c) => c.text('Not found', 404));

  return { app, pendingTokens };
}
