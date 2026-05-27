/**
 * `oauth_tokens` table CRUD. Issued access_token + refresh_token pairs from
 * the OAuth provider flow. Both tokens are stored as SHA-256 hashes; plaintext
 * is shown to the client once at issuance.
 *
 *   access_token format: `hmcp_` + 43 base64url chars (same shape as bearer
 *                        path; the middleware looks up here first, falls back
 *                        to connection_tokens).
 *   refresh_token format: `hmcprt_` + 43 base64url chars (distinct prefix so
 *                         logs/inspection can tell them apart).
 *
 * Refresh-token rotation: on /oauth/token with grant_type=refresh_token, the
 * old row is marked revoked and a new row is inserted with fresh hashes.
 */

import type { Queryable } from '../pool.js';

export interface OAuthTokenRow {
  accessTokenHash: Uint8Array;
  refreshTokenHash: Uint8Array;
  clientId: string;
  userId: string;
  expiresAt: Date;
  refreshExpiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface InsertTokenInput {
  accessTokenHash: Uint8Array;
  refreshTokenHash: Uint8Array;
  clientId: string;
  userId: string;
  expiresAt: Date;
  refreshExpiresAt: Date;
}

export async function insertOAuthToken(
  db: Queryable,
  input: InsertTokenInput,
): Promise<OAuthTokenRow> {
  const res = await db.query<RawRow>(
    `INSERT INTO oauth_tokens
       (access_token_hash, refresh_token_hash, client_id, user_id,
        expires_at, refresh_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING access_token_hash, refresh_token_hash, client_id, user_id,
               expires_at, refresh_expires_at, revoked_at, created_at`,
    [
      Buffer.from(input.accessTokenHash),
      Buffer.from(input.refreshTokenHash),
      input.clientId,
      input.userId,
      input.expiresAt,
      input.refreshExpiresAt,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('insertOAuthToken: no row returned');
  return toRow(row);
}

/** Look up an active, unexpired OAuth token by SHA-256(access_token). */
export async function findActiveOAuthTokenByAccessHash(
  db: Queryable,
  accessTokenHash: Uint8Array,
): Promise<OAuthTokenRow | null> {
  const res = await db.query<RawRow>(
    `SELECT access_token_hash, refresh_token_hash, client_id, user_id,
            expires_at, refresh_expires_at, revoked_at, created_at
       FROM oauth_tokens
      WHERE access_token_hash = $1
        AND revoked_at IS NULL
        AND expires_at > now()`,
    [Buffer.from(accessTokenHash)],
  );
  const row = res.rows[0];
  return row ? toRow(row) : null;
}

/** Look up a token by refresh hash. Returns the row regardless of revoke /
 *  expiry — the caller decides what's still usable. */
export async function findOAuthTokenByRefreshHash(
  db: Queryable,
  refreshTokenHash: Uint8Array,
): Promise<OAuthTokenRow | null> {
  const res = await db.query<RawRow>(
    `SELECT access_token_hash, refresh_token_hash, client_id, user_id,
            expires_at, refresh_expires_at, revoked_at, created_at
       FROM oauth_tokens WHERE refresh_token_hash = $1`,
    [Buffer.from(refreshTokenHash)],
  );
  const row = res.rows[0];
  return row ? toRow(row) : null;
}

/** Look up a token by access hash regardless of revoke/expiry. Used by the
 *  revoke endpoint (RFC 7009 — revocation is always 200, even on already-
 *  revoked or expired tokens). */
export async function findOAuthTokenByAccessHash(
  db: Queryable,
  accessTokenHash: Uint8Array,
): Promise<OAuthTokenRow | null> {
  const res = await db.query<RawRow>(
    `SELECT access_token_hash, refresh_token_hash, client_id, user_id,
            expires_at, refresh_expires_at, revoked_at, created_at
       FROM oauth_tokens WHERE access_token_hash = $1`,
    [Buffer.from(accessTokenHash)],
  );
  const row = res.rows[0];
  return row ? toRow(row) : null;
}

export async function revokeOAuthTokenByAccessHash(
  db: Queryable,
  accessTokenHash: Uint8Array,
): Promise<void> {
  await db.query(
    `UPDATE oauth_tokens SET revoked_at = now()
      WHERE access_token_hash = $1 AND revoked_at IS NULL`,
    [Buffer.from(accessTokenHash)],
  );
}

export async function revokeOAuthTokenByRefreshHash(
  db: Queryable,
  refreshTokenHash: Uint8Array,
): Promise<void> {
  await db.query(
    `UPDATE oauth_tokens SET revoked_at = now()
      WHERE refresh_token_hash = $1 AND revoked_at IS NULL`,
    [Buffer.from(refreshTokenHash)],
  );
}

export async function revokeAllTokensForClient(
  db: Queryable,
  clientId: string,
): Promise<number> {
  const res = await db.query(
    `UPDATE oauth_tokens SET revoked_at = now()
      WHERE client_id = $1 AND revoked_at IS NULL`,
    [clientId],
  );
  return res.rowCount ?? 0;
}

export async function listActiveTokensForUserClient(
  db: Queryable,
  userId: string,
  clientId: string,
): Promise<OAuthTokenRow[]> {
  const res = await db.query<RawRow>(
    `SELECT access_token_hash, refresh_token_hash, client_id, user_id,
            expires_at, refresh_expires_at, revoked_at, created_at
       FROM oauth_tokens
      WHERE user_id = $1 AND client_id = $2 AND revoked_at IS NULL
      ORDER BY created_at DESC`,
    [userId, clientId],
  );
  return res.rows.map(toRow);
}

interface RawRow {
  access_token_hash: Buffer;
  refresh_token_hash: Buffer;
  client_id: string;
  user_id: string;
  expires_at: Date;
  refresh_expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}

function toRow(r: RawRow): OAuthTokenRow {
  return {
    accessTokenHash: new Uint8Array(r.access_token_hash),
    refreshTokenHash: new Uint8Array(r.refresh_token_hash),
    clientId: r.client_id,
    userId: r.user_id,
    expiresAt: r.expires_at,
    refreshExpiresAt: r.refresh_expires_at,
    revokedAt: r.revoked_at,
    createdAt: r.created_at,
  };
}
