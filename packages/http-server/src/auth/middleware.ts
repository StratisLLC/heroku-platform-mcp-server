/**
 * Hono middleware: extract bearer/session credentials, attach a request
 * context.
 *
 * We deliberately keep the middleware narrow — it doesn't do access-control
 * re-evaluation (that happens at MCP dispatch time, against fresh DB rows) or
 * audit writes (those happen at the tool-call boundary). The middleware's
 * single job is to authenticate the principal and stash it on the Hono
 * context.
 */

import type { Context, Next } from 'hono';
import type pg from 'pg';
import type { PublicUrlResolver } from '../public-url.js';
import {
  findActiveTokenByHash,
  touchTokenLastUsed,
  type ConnectionTokenRow,
} from '../db/repos/connection-tokens.js';
import {
  findActiveOAuthTokenByAccessHash,
  type OAuthTokenRow,
} from '../db/repos/oauth-tokens.js';
import { touchClientLastUsed } from '../db/repos/oauth-clients.js';
import { findUserById, touchLastSeen, type UserRow } from '../db/repos/users.js';
import { isAdminEmail } from '../access/allowlist.js';
import { hashToken, parseBearer } from './connection-token.js';
import { openSession, WEB_SESSION_COOKIE, type WebSessionData } from './session.js';
import { getCookie } from '../routes/cookies.js';

export interface AppEnv {
  Variables: {
    auth?: AuthenticatedPrincipal | null;
  };
}

export interface AuthenticatedPrincipal {
  kind: 'web' | 'bearer' | 'oauth';
  user: UserRow;
  /** Set when authenticated by long-lived bearer token (connection_tokens). */
  connectionToken?: ConnectionTokenRow;
  /** Set when authenticated by OAuth-issued access token (oauth_tokens). */
  oauthToken?: OAuthTokenRow;
  isAdmin: boolean;
}

export interface MiddlewareDeps {
  pool: pg.Pool;
  masterKey: Uint8Array;
  adminEmails: string[];
  /** Resolves the base URL used to build the WWW-Authenticate `resource_metadata`
   *  parameter on 401 — this is how Claude Desktop discovers our auth server.
   *  Read inside the handler (per request), after the public-url middleware has
   *  had a chance to resolve it. */
  publicUrlResolver: PublicUrlResolver;
}

/**
 * Resolve the bearer token from the Authorization header (if present),
 * verify it, and put the resolved principal on context. Updates
 * `last_used_at` / `last_seen_at` as a side effect.
 *
 * Two lookups, in order:
 *   1. oauth_tokens (Phase 4.5 OAuth provider flow) — short-lived, must not
 *      be expired or revoked.
 *   2. connection_tokens (Phase 4 bearer flow) — long-lived, only revocation
 *      gates use.
 *
 * Both store SHA-256(token) of `hmcp_`-prefixed values, so the same incoming
 * Authorization header works for either path.
 *
 * On 401, we attach the RFC 9728 `WWW-Authenticate: Bearer
 * resource_metadata="<base>/.well-known/oauth-protected-resource"` header so
 * MCP clients (Claude Desktop) can discover the auth server and start a fresh
 * OAuth flow.
 */
export function bearerAuth(deps: MiddlewareDeps) {
  const unauth = (c: Context<AppEnv>, message: string): Response => {
    const base = deps.publicUrlResolver.getOrThrow().replace(/\/$/, '');
    c.header(
      'WWW-Authenticate',
      `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
    );
    return c.json({ ok: false, error: { kind: 'auth', message } }, 401);
  };

  return async (c: Context<AppEnv>, next: Next): Promise<void | Response> => {
    const token = parseBearer(c.req.header('authorization'));
    if (!token) {
      return unauth(c, 'missing bearer token');
    }
    const hash = hashToken(token);

    // 1) OAuth-provider issued access token (Phase 4.5).
    const oauthRow = await findActiveOAuthTokenByAccessHash(deps.pool, hash);
    if (oauthRow) {
      const user = await findUserById(deps.pool, oauthRow.userId);
      if (!user) {
        return unauth(c, 'user not found');
      }
      await touchClientLastUsed(deps.pool, oauthRow.clientId).catch(() => undefined);
      await touchLastSeen(deps.pool, user.id).catch(() => undefined);
      const principal: AuthenticatedPrincipal = {
        kind: 'oauth',
        user,
        oauthToken: oauthRow,
        isAdmin: isAdminEmail(user.email, deps.adminEmails),
      };
      c.set('auth', principal);
      await next();
      return;
    }

    // 2) Long-lived bearer token (Phase 4).
    const tokenRow = await findActiveTokenByHash(deps.pool, hash);
    if (!tokenRow) {
      return unauth(c, 'invalid or revoked token');
    }
    const user = await findUserById(deps.pool, tokenRow.userId);
    if (!user) {
      return unauth(c, 'user not found');
    }
    await touchTokenLastUsed(deps.pool, tokenRow.id).catch(() => undefined);
    await touchLastSeen(deps.pool, user.id).catch(() => undefined);

    const principal: AuthenticatedPrincipal = {
      kind: 'bearer',
      user,
      connectionToken: tokenRow,
      isAdmin: isAdminEmail(user.email, deps.adminEmails),
    };
    c.set('auth', principal);
    await next();
  };
}

/** Resolve the web session cookie. Always succeeds — the route decides
 *  whether to redirect to /sign-in if `auth` is not set. */
export function webSessionAuth(deps: MiddlewareDeps) {
  return async (c: Context<AppEnv>, next: Next): Promise<void> => {
    const cookie = getCookie(c, WEB_SESSION_COOKIE);
    const data = openSession<WebSessionData>(cookie, deps.masterKey);
    if (!data) {
      c.set('auth', null);
      await next();
      return;
    }
    const user = await findUserById(deps.pool, data.userId);
    if (!user) {
      c.set('auth', null);
      await next();
      return;
    }
    await touchLastSeen(deps.pool, user.id).catch(() => undefined);
    c.set('auth', {
      kind: 'web',
      user,
      isAdmin: isAdminEmail(user.email, deps.adminEmails),
    });
    await next();
  };
}

/** Require a web sign-in; otherwise redirect to /sign-in. */
export function requireWebAuth() {
  return async (c: Context<AppEnv>, next: Next): Promise<void | Response> => {
    const auth = c.get('auth');
    if (auth?.kind !== 'web') {
      const target = encodeURIComponent(c.req.path);
      return c.redirect(`/sign-in?next=${target}`);
    }
    await next();
  };
}

/** Require admin role; otherwise 404 (per DECISION 9 — don't reveal admin
 *  pages exist). */
export function requireAdmin() {
  return async (c: Context<AppEnv>, next: Next): Promise<void | Response> => {
    const auth = c.get('auth');
    if (auth?.kind !== 'web' || !auth.isAdmin) {
      return c.text('Not found', 404);
    }
    await next();
  };
}
