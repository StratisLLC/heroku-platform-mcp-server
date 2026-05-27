/**
 * /audit — the user's own audit log (filtered, paginated, CSV-exportable,
 * self-prunable).
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type pg from 'pg';
import {
  listAuditEntries,
  pruneAuditEntries,
  type AuditEntryRow,
  type AuditStatus,
} from '../db/repos/audit-log.js';
import { renderAudit, type AuditFilters } from '../views/pages.js';
import type { AppEnv } from '../auth/middleware.js';

export interface AuditRoutesDeps {
  pool: pg.Pool;
}

export const AUDIT_PER_PAGE = 50;

export function buildAuditRoutes(deps: AuditRoutesDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get('/audit', async (c) => {
    const auth = c.get('auth');
    if (auth?.kind !== 'web') return c.redirect('/sign-in?next=/audit');
    const filters = readFilters(c);
    const page = readPage(c);
    const { rows, total } = await listAuditEntries(deps.pool, {
      userId: auth.user.id,
      ...buildFilterOpts(filters),
      limit: AUDIT_PER_PAGE,
      offset: (page - 1) * AUDIT_PER_PAGE,
    });
    return c.html(
      renderAudit(
        { signedIn: true, admin: auth.isAdmin, currentPath: '/audit' },
        {
          rows,
          total,
          page,
          perPage: AUDIT_PER_PAGE,
          filters,
          exportHref: `/audit/export${currentQuery(c)}`,
          selfPruneHref: '/audit/prune',
          baseHref: '/audit',
        },
      ),
    );
  });

  router.get('/audit/export', async (c) => {
    const auth = c.get('auth');
    if (auth?.kind !== 'web') return c.redirect('/sign-in?next=/audit');
    const filters = readFilters(c);
    const { rows } = await listAuditEntries(deps.pool, {
      userId: auth.user.id,
      ...buildFilterOpts(filters),
      limit: 10_000,
    });
    return new Response(rowsToCsv(rows), {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="audit-${auth.user.email}.csv"`,
      },
    });
  });

  router.post('/audit/prune', async (c) => {
    const auth = c.get('auth');
    if (auth?.kind !== 'web') return c.redirect('/sign-in');
    const form = await c.req.formData();
    const days = Number(form.get('days'));
    if (!Number.isFinite(days) || days < 1) {
      return c.text('days must be a positive integer', 400);
    }
    const before = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    await pruneAuditEntries(deps.pool, { before, userId: auth.user.id });
    return c.redirect('/audit');
  });

  return router;
}

export function readFilters(c: Context<AppEnv>): AuditFilters {
  const out: AuditFilters = {};
  const tool = c.req.query('tool');
  if (tool) out.tool = tool;
  const status = c.req.query('status');
  if (status === 'ok' || status === 'error' || status === 'rejected') out.status = status;
  const since = c.req.query('since');
  if (since) out.since = since;
  const until = c.req.query('until');
  if (until) out.until = until;
  return out;
}

export function readPage(c: Context<AppEnv>): number {
  const raw = c.req.query('page');
  const n = raw ? Number.parseInt(raw, 10) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export function buildFilterOpts(filters: AuditFilters): {
  tool?: string;
  status?: AuditStatus;
  since?: Date;
  until?: Date;
} {
  const out: { tool?: string; status?: AuditStatus; since?: Date; until?: Date } = {};
  if (filters.tool !== undefined) out.tool = filters.tool;
  if (filters.status !== undefined) out.status = filters.status;
  if (filters.since !== undefined) {
    const d = new Date(filters.since);
    if (!Number.isNaN(d.valueOf())) out.since = d;
  }
  if (filters.until !== undefined) {
    const d = new Date(filters.until);
    if (!Number.isNaN(d.valueOf())) out.until = d;
  }
  return out;
}

function currentQuery(c: Context<AppEnv>): string {
  const url = new URL(c.req.url);
  return url.search;
}

export function rowsToCsv(rows: AuditEntryRow[]): string {
  const header = [
    'id',
    'occurred_at',
    'user_id',
    'category',
    'event',
    'status',
    'duration_ms',
    'client_name',
    'client_version',
    'request_id',
    'details',
  ];
  const lines = [header.map(csvEscape).join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.occurredAt.toISOString(),
        r.userId ?? '',
        r.category,
        r.eventName,
        r.status,
        r.durationMs ?? '',
        r.clientName ?? '',
        r.clientVersion ?? '',
        r.requestId ?? '',
        r.details ? JSON.stringify(r.details) : '',
      ]
        .map((v) => csvEscape(String(v)))
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
