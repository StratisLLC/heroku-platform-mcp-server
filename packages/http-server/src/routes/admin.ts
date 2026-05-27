/**
 * /admin/* — operator/admin pages, gated on MCP_ADMIN_EMAILS.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type pg from 'pg';
import {
  countActiveTokensForUser,
  listAllTokens,
  revokeAllUserTokens,
  revokeToken,
  type ConnectionTokenRow,
} from '../db/repos/connection-tokens.js';
import { findUserById, listAllUsers as listUsers } from '../db/repos/users.js';
import { listAuditEntries, appendAuditEntry } from '../db/repos/audit-log.js';
import { listAppliedMigrations } from '../db/migrate.js';
import {
  renderAdminConfig,
  renderAdminStatus,
  renderAdminTokens,
  renderAdminUsers,
  renderAudit,
} from '../views/pages.js';
import { masterKeyFingerprint } from '@heroku-mcp/core';
import type { AppEnv } from '../auth/middleware.js';
import type { Config } from '../config.js';
import type { TransportManager } from '../mcp/transport.js';
import { buildFilterOpts, readFilters, readPage, rowsToCsv } from './audit.js';

export interface AdminRoutesDeps {
  pool: pg.Pool;
  cfg: Config;
  transports: TransportManager;
  /** Fetch-style probe target for Heroku reachability. Default uses
   *  `fetch('https://api.heroku.com')`. */
  herokuProbe?: () => Promise<boolean>;
}

const ADMIN_PER_PAGE = 100;

export function buildAdminRoutes(deps: AdminRoutesDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get('/admin/users', async (c) => {
    const users = await listUsers(deps.pool);
    const rows = await Promise.all(
      users.map(async (user) => ({
        user,
        activeTokenCount: await countActiveTokensForUser(deps.pool, user.id),
      })),
    );
    return c.html(
      renderAdminUsers({ signedIn: true, admin: true, currentPath: '/admin/users' }, { rows }),
    );
  });

  router.post('/admin/users/:id/revoke-all', async (c) => {
    const id = c.req.param('id');
    const user = await findUserById(deps.pool, id);
    if (!user) return c.text('Not found', 404);
    const n = await revokeAllUserTokens(deps.pool, user.id);
    deps.transports.evictByUser(user.id);
    const acting = c.get('auth');
    await appendAuditEntry(deps.pool, {
      userId: user.id,
      category: 'auth',
      eventName: 'admin_revoke_all_tokens',
      status: 'ok',
      details: {
        revoked_count: n,
        actor_email: acting?.user.email,
      },
    }).catch(() => undefined);
    return c.redirect('/admin/users');
  });

  router.get('/admin/tokens', async (c) => {
    const tokens = await listAllTokens(deps.pool, { includeRevoked: true });
    const userIds = Array.from(new Set(tokens.map((t) => t.userId)));
    const userById = new Map<string, string>();
    for (const uid of userIds) {
      const u = await findUserById(deps.pool, uid);
      if (u) userById.set(uid, u.email);
    }
    const rows = tokens.map((token: ConnectionTokenRow) => ({
      token,
      userEmail: userById.get(token.userId) ?? '<unknown>',
    }));
    return c.html(
      renderAdminTokens({ signedIn: true, admin: true, currentPath: '/admin/tokens' }, { rows }),
    );
  });

  router.post('/admin/tokens/:id/revoke', async (c) => {
    const id = c.req.param('id');
    await revokeToken(deps.pool, id);
    deps.transports.evictByConnectionToken(id);
    const acting = c.get('auth');
    await appendAuditEntry(deps.pool, {
      userId: null,
      category: 'auth',
      eventName: 'admin_revoke_token',
      status: 'ok',
      details: { token_id: id, actor_email: acting?.user.email },
    }).catch(() => undefined);
    return c.redirect('/admin/tokens');
  });

  router.get('/admin/audit', async (c) => {
    const filters = readFilters(c);
    const page = readPage(c);
    const { rows, total } = await listAuditEntries(deps.pool, {
      ...buildFilterOpts(filters),
      limit: ADMIN_PER_PAGE,
      offset: (page - 1) * ADMIN_PER_PAGE,
    });
    return c.html(
      renderAudit(
        { signedIn: true, admin: true, currentPath: '/admin/audit' },
        {
          rows,
          total,
          page,
          perPage: ADMIN_PER_PAGE,
          filters,
          exportHref: `/admin/audit/export${currentQuery(c)}`,
          baseHref: '/admin/audit',
        },
        'All audit',
      ),
    );
  });

  router.get('/admin/audit/export', async (c) => {
    const filters = readFilters(c);
    const { rows } = await listAuditEntries(deps.pool, {
      ...buildFilterOpts(filters),
      limit: 50_000,
    });
    return new Response(rowsToCsv(rows), {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="audit-all.csv"`,
      },
    });
  });

  router.get('/admin/status', async (c) => {
    const herokuApiReachable = await (deps.herokuProbe ?? defaultHerokuProbe)();
    let dbReachable = false;
    let appliedMigrations: string[] = [];
    try {
      await deps.pool.query('SELECT 1');
      dbReachable = true;
      appliedMigrations = await listAppliedMigrations(deps.pool);
    } catch {
      dbReachable = false;
    }
    const tokens = await listAllTokens(deps.pool);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { total: recentErrors } = await listAuditEntries(deps.pool, {
      status: 'error',
      since,
      limit: 1,
    });
    return c.html(
      renderAdminStatus(
        { signedIn: true, admin: true, currentPath: '/admin/status' },
        {
          herokuApiReachable,
          dbReachable,
          activeTokens: tokens.length,
          recentErrors,
          masterKeyFingerprint: masterKeyFingerprint(deps.cfg.masterKey),
          appliedMigrations,
        },
      ),
    );
  });

  router.get('/admin/config', (c) => {
    return c.html(
      renderAdminConfig(
        { signedIn: true, admin: true, currentPath: '/admin/config' },
        { env: deps.cfg.rawEnvForAdmin },
      ),
    );
  });

  return router;
}

async function defaultHerokuProbe(): Promise<boolean> {
  try {
    const res = await fetch('https://api.heroku.com/schema', {
      method: 'HEAD',
      headers: { Accept: 'application/vnd.heroku+json; version=3' },
      signal: AbortSignal.timeout(5000),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

function currentQuery(c: Context<AppEnv>): string {
  return new URL(c.req.url).search;
}
