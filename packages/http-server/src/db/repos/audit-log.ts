/**
 * `audit_log` table CRUD. Append-only, queried by /audit and /admin/audit.
 *
 * `details` is intentionally a flexible jsonb blob — different event categories
 * carry different fields. The audit wrapper records:
 *   tool_call: { tool, dry_run, confirm_present, args (sanitized), method, path,
 *                response_status }
 *   auth:      { reason, mcp_token_id?, email? }
 *   system:    { component, message }
 */

import type { Queryable } from '../pool.js';

export type AuditCategory = 'tool_call' | 'auth' | 'system';
export type AuditStatus = 'ok' | 'error' | 'rejected';

export interface AuditEntryInput {
  userId: string | null;
  category: AuditCategory;
  eventName: string;
  status: AuditStatus;
  requestId?: string | null;
  durationMs?: number | null;
  clientName?: string | null;
  clientVersion?: string | null;
  details?: Record<string, unknown> | null;
}

export interface AuditEntryRow {
  id: string;
  occurredAt: Date;
  userId: string | null;
  category: AuditCategory;
  eventName: string;
  status: AuditStatus;
  requestId: string | null;
  durationMs: number | null;
  clientName: string | null;
  clientVersion: string | null;
  details: Record<string, unknown> | null;
}

export async function appendAuditEntry(db: Queryable, input: AuditEntryInput): Promise<void> {
  await db.query(
    `INSERT INTO audit_log
       (user_id, event_category, event_name, status, request_id, duration_ms,
        client_name, client_version, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.userId,
      input.category,
      input.eventName,
      input.status,
      input.requestId ?? null,
      input.durationMs ?? null,
      input.clientName ?? null,
      input.clientVersion ?? null,
      input.details ? JSON.stringify(input.details) : null,
    ],
  );
}

export interface ListAuditOptions {
  userId?: string;
  /** When set, restricts to this category. */
  category?: AuditCategory;
  /** When set, restricts to entries whose event_name === tool. */
  tool?: string;
  /** When set, restricts to entries with this status. */
  status?: AuditStatus;
  since?: Date;
  until?: Date;
  limit?: number;
  offset?: number;
}

export interface ListAuditResult {
  rows: AuditEntryRow[];
  total: number;
}

export async function listAuditEntries(
  db: Queryable,
  opts: ListAuditOptions = {},
): Promise<ListAuditResult> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.userId !== undefined) {
    params.push(opts.userId);
    where.push(`user_id = $${params.length}`);
  }
  if (opts.category !== undefined) {
    params.push(opts.category);
    where.push(`event_category = $${params.length}`);
  }
  if (opts.tool !== undefined) {
    params.push(opts.tool);
    where.push(`event_name = $${params.length}`);
  }
  if (opts.status !== undefined) {
    params.push(opts.status);
    where.push(`status = $${params.length}`);
  }
  if (opts.since !== undefined) {
    params.push(opts.since);
    where.push(`occurred_at >= $${params.length}`);
  }
  if (opts.until !== undefined) {
    params.push(opts.until);
    where.push(`occurred_at < $${params.length}`);
  }
  const whereClause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 1000);
  const offset = Math.max(0, opts.offset ?? 0);

  const totalRes = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit_log ${whereClause}`,
    params,
  );
  const total = Number(totalRes.rows[0]?.count ?? '0');

  const rowsRes = await db.query<RawRow>(
    `SELECT id::text, occurred_at, user_id, event_category, event_name, status,
            request_id, duration_ms, client_name, client_version, details
       FROM audit_log ${whereClause}
       ORDER BY occurred_at DESC, id DESC
       LIMIT ${limit} OFFSET ${offset}`,
    params,
  );

  return { rows: rowsRes.rows.map(toRow), total };
}

export async function pruneAuditEntries(
  db: Queryable,
  opts: { before: Date; userId?: string },
): Promise<number> {
  if (opts.userId !== undefined) {
    const res = await db.query(`DELETE FROM audit_log WHERE user_id = $1 AND occurred_at < $2`, [
      opts.userId,
      opts.before,
    ]);
    return res.rowCount ?? 0;
  }
  const res = await db.query(`DELETE FROM audit_log WHERE occurred_at < $1`, [opts.before]);
  return res.rowCount ?? 0;
}

interface RawRow {
  id: string;
  occurred_at: Date;
  user_id: string | null;
  event_category: AuditCategory;
  event_name: string;
  status: AuditStatus;
  request_id: string | null;
  duration_ms: number | null;
  client_name: string | null;
  client_version: string | null;
  details: Record<string, unknown> | null;
}

function toRow(r: RawRow): AuditEntryRow {
  return {
    id: r.id,
    occurredAt: r.occurred_at,
    userId: r.user_id,
    category: r.event_category,
    eventName: r.event_name,
    status: r.status,
    requestId: r.request_id,
    durationMs: r.duration_ms,
    clientName: r.client_name,
    clientVersion: r.client_version,
    details: r.details,
  };
}
