/**
 * Public routes: landing, sign-in initiation, OAuth callback, sign-out.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type pg from 'pg';
import type { Config } from '../config.js';
import type { HerokuOAuthConfig } from '../oauth/heroku.js';
import {
  beginSignIn,
  completeSignIn,
  SignInError,
  type CompleteSignInResult,
} from '../oauth/flow.js';
import {
  OAUTH_FLOW_COOKIE,
  OAUTH_FLOW_TTL_MS,
  WEB_SESSION_COOKIE,
  WEB_SESSION_TTL_MS,
  openSession,
  sealSession,
  type OAuthFlowState,
  type WebSessionData,
} from '../auth/session.js';
import { clearCookie, getCookie, setCookie } from './cookies.js';
import { renderAccessDenied, renderLanding, renderSimpleError } from '../views/pages.js';
import type { AppEnv } from '../auth/middleware.js';
import { maskEmail } from '../access/allowlist.js';
import { appendAuditEntry } from '../db/repos/audit-log.js';
import { revokeAllUserTokens } from '../db/repos/connection-tokens.js';
import { deleteHerokuTokens } from '../db/repos/heroku-tokens.js';
import type { TransportManager } from '../mcp/transport.js';

export interface PublicRoutesDeps {
  pool: pg.Pool;
  cfg: Config;
  oauthCfg: HerokuOAuthConfig;
  transports: TransportManager;
  /** "One-time" cache from completeSignIn → /me. Map of session-cookie value
   *  to the plaintext token so we can render it on /me's first paint. */
  pendingTokens: Map<string, string>;
}

const CallbackQuery = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

export function buildPublicRoutes(deps: PublicRoutesDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get('/', (c) => {
    const auth = c.get('auth');
    return c.html(
      renderLanding(
        {
          signedIn: Boolean(auth),
          admin: auth?.isAdmin ?? false,
          currentPath: '/',
        },
        auth?.user.email,
      ),
    );
  });

  router.get('/health', (c) => c.json({ ok: true }));

  router.get('/sign-in', (c) => {
    const next = c.req.query('next');
    const { redirectUrl, flowState } = beginSignIn(
      deps.oauthCfg,
      next ? { redirectAfterLogin: next } : {},
    );
    const sealed = sealSession<OAuthFlowState>(flowState, OAUTH_FLOW_TTL_MS, deps.cfg.masterKey);
    setCookie(c, OAUTH_FLOW_COOKIE, sealed, {
      httpOnly: true,
      secure: deps.cfg.isProduction,
      sameSite: 'Lax',
      maxAgeSeconds: Math.floor(OAUTH_FLOW_TTL_MS / 1000),
    });
    return c.redirect(redirectUrl);
  });

  router.get('/oauth/callback', async (c) => {
    const parsed = CallbackQuery.safeParse({
      code: c.req.query('code'),
      state: c.req.query('state'),
      error: c.req.query('error'),
      error_description: c.req.query('error_description'),
    });
    if (!parsed.success) {
      return c.html(
        renderSimpleError(
          viewerCtx(c, '/oauth/callback'),
          'Bad request',
          'Malformed OAuth callback.',
        ),
        400,
      );
    }
    if (parsed.data.error) {
      const desc = parsed.data.error_description ?? parsed.data.error;
      return c.html(
        renderSimpleError(viewerCtx(c, '/oauth/callback'), 'Heroku declined the sign-in', desc),
        400,
      );
    }
    const code = parsed.data.code;
    const state = parsed.data.state;
    if (!code || !state) {
      return c.html(
        renderSimpleError(
          viewerCtx(c, '/oauth/callback'),
          'Bad request',
          'OAuth callback missing code or state.',
        ),
        400,
      );
    }
    const flowCookie = getCookie(c, OAUTH_FLOW_COOKIE);
    const flow = openSession<OAuthFlowState>(flowCookie, deps.cfg.masterKey);
    if (!flow) {
      return c.html(
        renderSimpleError(
          viewerCtx(c, '/oauth/callback'),
          'Sign-in expired',
          'Your sign-in flow expired before completing. Please try again.',
        ),
        400,
      );
    }
    clearCookie(c, OAUTH_FLOW_COOKIE, deps.cfg.isProduction);

    let result: CompleteSignInResult;
    try {
      result = await completeSignIn(
        { code, state, flow },
        {
          pool: deps.pool,
          cfg: deps.oauthCfg,
          masterKey: deps.cfg.masterKey,
          allowlist: {
            allowedEmails: deps.cfg.allowedEmails,
            allowedTeams: deps.cfg.allowedTeams,
          },
        },
      );
    } catch (err) {
      if (err instanceof SignInError && err.kind === 'access_denied') {
        const details = err.details as
          | {
              reason: 'email_not_allowed' | 'team_not_allowed' | 'no_match';
              account: { id: string; email: string };
              teams: string[];
            }
          | undefined;
        await appendAuditEntry(deps.pool, {
          userId: null,
          category: 'auth',
          eventName: 'access_denied',
          status: 'rejected',
          details: {
            reason: details?.reason,
            email: details?.account.email,
            herokuId: details?.account.id,
          },
        }).catch(() => undefined);
        const reasonText = describeReason(details?.reason);
        return c.html(
          renderAccessDenied(viewerCtx(c, '/oauth/callback'), {
            email: details?.account.email ?? '',
            herokuId: details?.account.id ?? '',
            teams: details?.teams ?? [],
            reason: reasonText,
            allowedEmailsMasked: deps.cfg.allowedEmails
              ? deps.cfg.allowedEmails.map(maskEmail)
              : null,
            allowedTeams: deps.cfg.allowedTeams,
            adminContact: deps.cfg.adminContact,
          }),
          403,
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      return c.html(renderSimpleError(viewerCtx(c, '/oauth/callback'), 'Sign-in failed', msg), 400);
    }

    // Audit + seal session cookie + stash plaintext token for /me first paint.
    await appendAuditEntry(deps.pool, {
      userId: result.user.id,
      category: 'auth',
      eventName: 'sign_in',
      status: 'ok',
      details: {
        email: result.user.email,
        herokuId: result.user.herokuId,
      },
    }).catch(() => undefined);
    await appendAuditEntry(deps.pool, {
      userId: result.user.id,
      category: 'auth',
      eventName: 'token_issued',
      status: 'ok',
      details: { label: 'Issued at sign-in' },
    }).catch(() => undefined);

    const session: WebSessionData = {
      userId: result.user.id,
      signedInAt: Date.now(),
    };
    const sealed = sealSession<WebSessionData>(session, WEB_SESSION_TTL_MS, deps.cfg.masterKey);
    setCookie(c, WEB_SESSION_COOKIE, sealed, {
      httpOnly: true,
      secure: deps.cfg.isProduction,
      sameSite: 'Lax',
      maxAgeSeconds: Math.floor(WEB_SESSION_TTL_MS / 1000),
    });
    deps.pendingTokens.set(sealed, result.newConnectionToken.plaintext);

    // Honor the original sign-in initiator's redirect target. Restricted to
    // same-origin (must start with '/') to avoid open-redirect. The OAuth
    // provider authorize endpoint uses this to bring the user back to a
    // /oauth/authorize?... URL after a successful Heroku sign-in.
    const target =
      typeof result.redirectAfterLogin === 'string' &&
      result.redirectAfterLogin.startsWith('/') &&
      !result.redirectAfterLogin.startsWith('//')
        ? result.redirectAfterLogin
        : '/me';
    return c.redirect(target);
  });

  router.post('/sign-out', async (c) => {
    const auth = c.get('auth');
    if (auth) {
      await appendAuditEntry(deps.pool, {
        userId: auth.user.id,
        category: 'auth',
        eventName: 'sign_out',
        status: 'ok',
      }).catch(() => undefined);
    }
    clearCookie(c, WEB_SESSION_COOKIE, deps.cfg.isProduction);
    return c.redirect('/');
  });

  router.post('/me/sign-out-everywhere', async (c) => {
    const auth = c.get('auth');
    if (auth?.kind !== 'web') return c.redirect('/sign-in');
    const n = await revokeAllUserTokens(deps.pool, auth.user.id);
    // Also clear the stored upstream Heroku token. "Everywhere" is a full reset:
    // dropping the row lets a user with a poisoned/revoked Heroku token recover
    // from the UI — the next sign-in mints a clean one. Plain /sign-out does NOT
    // do this (it must not force every other session to re-auth Heroku).
    await deleteHerokuTokens(deps.pool, auth.user.id);
    deps.transports.evictByUser(auth.user.id);
    await appendAuditEntry(deps.pool, {
      userId: auth.user.id,
      category: 'auth',
      eventName: 'revoke_all_tokens',
      status: 'ok',
      details: { revoked_count: n },
    }).catch(() => undefined);
    return c.redirect('/me');
  });

  return router;
}

function describeReason(
  reason: 'email_not_allowed' | 'team_not_allowed' | 'no_match' | undefined,
): string {
  switch (reason) {
    case 'email_not_allowed':
      return 'your email is not on the allowlist';
    case 'team_not_allowed':
      return 'you are not a member of any allowed Heroku team';
    case 'no_match':
      return 'neither your email nor team memberships match the allowlist';
    default:
      return 'access denied';
  }
}

function viewerCtx(c: Context<AppEnv>, currentPath: string) {
  const auth = c.get('auth');
  return {
    signedIn: Boolean(auth),
    admin: auth?.isAdmin ?? false,
    currentPath,
  };
}
