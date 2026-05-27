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
import {
  findActiveTokenByHash,
  touchTokenLastUsed,
  type ConnectionTokenRow,
} from '../db/repos/connection-tokens.js';
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
  kind: 'web' | 'bearer';
  user: UserRow;
  /** Set when authenticated by Bearer token. */
  connectionToken?: ConnectionTokenRow;
  isAdmin: boolean;
}

export interface MiddlewareDeps {
  pool: pg.Pool;
  masterKey: Uint8Array;
  adminEmails: string[];
}

/**
 * Resolve the bearer token from the Authorization header (if present),
 * verify it, and put the resolved principal on context. Updates
 * `last_used_at` / `last_seen_at` as a side effect.
 */
export function bearerAuth(deps: MiddlewareDeps) {
  return async (c: Context<AppEnv>, next: Next): Promise<void | Response> => {
    const token = parseBearer(c.req.header('authorization'));
    if (!token) {
      return c.json({ ok: false, error: { kind: 'auth', message: 'missing bearer token' } }, 401);
    }
    const hash = hashToken(token);
    const tokenRow = await findActiveTokenByHash(deps.pool, hash);
    if (!tokenRow) {
      return c.json(
        { ok: false, error: { kind: 'auth', message: 'invalid or revoked token' } },
        401,
      );
    }
    const user = await findUserById(deps.pool, tokenRow.userId);
    if (!user) {
      return c.json({ ok: false, error: { kind: 'auth', message: 'user not found' } }, 401);
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
