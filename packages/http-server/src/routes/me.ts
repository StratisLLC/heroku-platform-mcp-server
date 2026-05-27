/**
 * /me and /me/* — user-self routes.
 */

import { Hono } from 'hono';
import type pg from 'pg';
import { renderMe } from '../views/pages.js';
import type { AppEnv } from '../auth/middleware.js';
import {
  listUserTokens,
  revokeToken,
  findActiveTokenByHash,
} from '../db/repos/connection-tokens.js';
import { listClientsForUser, revokeOAuthClient } from '../db/repos/oauth-clients.js';
import { revokeAllTokensForClient } from '../db/repos/oauth-tokens.js';
import { getCookie } from './cookies.js';
import { WEB_SESSION_COOKIE } from '../auth/session.js';
import type { Config } from '../config.js';
import type { TransportManager } from '../mcp/transport.js';
import { appendAuditEntry } from '../db/repos/audit-log.js';

export interface MeRoutesDeps {
  pool: pg.Pool;
  cfg: Config;
  /** Map from sealed session-cookie value to a freshly-minted plaintext token,
   *  populated by the /oauth/callback handler. Read once and removed. */
  pendingTokens: Map<string, string>;
  transports: TransportManager;
}

export function buildMeRoutes(deps: MeRoutesDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get('/me', async (c) => {
    const auth = c.get('auth');
    if (auth?.kind !== 'web') return c.redirect('/sign-in?next=/me');
    const tokens = await listUserTokens(deps.pool, auth.user.id);
    const clients = await listClientsForUser(deps.pool, auth.user.id);
    const sealed = getCookie(c, WEB_SESSION_COOKIE);
    const pendingToken = sealed ? deps.pendingTokens.get(sealed) : undefined;
    if (sealed && pendingToken) deps.pendingTokens.delete(sealed);
    return c.html(
      renderMe(
        {
          signedIn: true,
          admin: auth.isAdmin,
          currentPath: '/me',
          publicUrl: deps.cfg.publicUrl,
        },
        {
          user: auth.user,
          publicUrl: deps.cfg.publicUrl,
          newToken: pendingToken ?? null,
          tokens,
          clients,
        },
      ),
    );
  });

  router.post('/me/tokens/:id/revoke', async (c) => {
    const auth = c.get('auth');
    if (auth?.kind !== 'web') return c.redirect('/sign-in');
    const id = c.req.param('id');
    // Verify the token belongs to the signed-in user before revoking.
    const tokens = await listUserTokens(deps.pool, auth.user.id, { includeRevoked: true });
    const owned = tokens.find((t) => t.id === id);
    if (!owned) {
      return c.text('Not found', 404);
    }
    await revokeToken(deps.pool, id);
    deps.transports.evictByConnectionToken(id);
    await appendAuditEntry(deps.pool, {
      userId: auth.user.id,
      category: 'auth',
      eventName: 'token_revoked',
      status: 'ok',
      details: { token_id: id },
    }).catch(() => undefined);
    return c.redirect('/me');
  });

  router.post('/me/clients/:id/revoke', async (c) => {
    const auth = c.get('auth');
    if (auth?.kind !== 'web') return c.redirect('/sign-in');
    const id = c.req.param('id');
    const clients = await listClientsForUser(deps.pool, auth.user.id, { includeRevoked: true });
    const owned = clients.find((c) => c.clientId === id);
    if (!owned) {
      return c.text('Not found', 404);
    }
    const revokedCount = await revokeAllTokensForClient(deps.pool, id);
    await revokeOAuthClient(deps.pool, id);
    deps.transports.evictByUser(auth.user.id);
    await appendAuditEntry(deps.pool, {
      userId: auth.user.id,
      category: 'auth',
      eventName: 'oauth_client_revoked',
      status: 'ok',
      details: { client_id: id, revoked_token_count: revokedCount },
    }).catch(() => undefined);
    return c.redirect('/me');
  });

  // helper for tests / programmatic uses — not a route.
  void findActiveTokenByHash;

  return router;
}
