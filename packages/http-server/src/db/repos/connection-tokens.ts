/**
 * `connection_tokens` table CRUD.
 *
 * The token plaintext is shown to the user once at issuance and never stored.
 * We store SHA-256(token) as bytea; lookups hash the incoming bearer token and
 * select by hash.
 */

import type { Queryable } from '../pool.js';

export interface ConnectionTokenRow {
  id: string;
  userId: string;
  tokenHash: Uint8Array;
  label: string | null;
  issuedAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface IssueConnectionTokenInput {
  userId: string;
  tokenHash: Uint8Array;
  label?: string | null;
}

export async function issueConnectionToken(
  db: Queryable,
  input: IssueConnectionTokenInput,
): Promise<ConnectionTokenRow> {
  const res = await db.query<RawRow>(
    `INSERT INTO connection_tokens (user_id, token_hash, label)
     VALUES ($1, $2, $3)
     RETURNING id, user_id, token_hash, label, issued_at, last_used_at, revoked_at`,
    [input.userId, Buffer.from(input.tokenHash), input.label ?? null],
  );
  const row = res.rows[0];
  if (!row) throw new Error('issueConnectionToken: no row returned');
  return toRow(row);
}

/** Look up a token by hash. Only returns rows that are not revoked. */
export async function findActiveTokenByHash(
  db: Queryable,
  tokenHash: Uint8Array,
): Promise<ConnectionTokenRow | null> {
  const res = await db.query<RawRow>(
    `SELECT id, user_id, token_hash, label, issued_at, last_used_at, revoked_at
       FROM connection_tokens
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [Buffer.from(tokenHash)],
  );
  const row = res.rows[0];
  return row ? toRow(row) : null;
}

export async function touchTokenLastUsed(db: Queryable, id: string): Promise<void> {
  await db.query(`UPDATE connection_tokens SET last_used_at = now() WHERE id = $1`, [id]);
}

export async function revokeToken(db: Queryable, id: string): Promise<void> {
  await db.query(
    `UPDATE connection_tokens SET revoked_at = now()
      WHERE id = $1 AND revoked_at IS NULL`,
    [id],
  );
}

export async function revokeAllUserTokens(db: Queryable, userId: string): Promise<number> {
  const res = await db.query(
    `UPDATE connection_tokens SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  return res.rowCount ?? 0;
}

export async function listUserTokens(
  db: Queryable,
  userId: string,
  opts: { includeRevoked?: boolean } = {},
): Promise<ConnectionTokenRow[]> {
  const where = opts.includeRevoked ? '' : 'AND revoked_at IS NULL';
  const res = await db.query<RawRow>(
    `SELECT id, user_id, token_hash, label, issued_at, last_used_at, revoked_at
       FROM connection_tokens
      WHERE user_id = $1 ${where}
      ORDER BY issued_at DESC`,
    [userId],
  );
  return res.rows.map(toRow);
}

export async function listAllTokens(
  db: Queryable,
  opts: { includeRevoked?: boolean } = {},
): Promise<ConnectionTokenRow[]> {
  const where = opts.includeRevoked ? '' : 'WHERE revoked_at IS NULL';
  const res = await db.query<RawRow>(
    `SELECT id, user_id, token_hash, label, issued_at, last_used_at, revoked_at
       FROM connection_tokens ${where}
       ORDER BY issued_at DESC`,
  );
  return res.rows.map(toRow);
}

export async function countActiveTokensForUser(db: Queryable, userId: string): Promise<number> {
  const res = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM connection_tokens
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  return Number(res.rows[0]?.count ?? '0');
}

interface RawRow {
  id: string;
  user_id: string;
  token_hash: Buffer;
  label: string | null;
  issued_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

function toRow(r: RawRow): ConnectionTokenRow {
  return {
    id: r.id,
    userId: r.user_id,
    tokenHash: new Uint8Array(r.token_hash),
    label: r.label,
    issuedAt: r.issued_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
  };
}
