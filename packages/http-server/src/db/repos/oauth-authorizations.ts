/**
 * `oauth_authorizations` table CRUD. Short-lived single-use authorization
 * codes for the OAuth code-grant flow. The code plaintext is shown to the
 * client once via the redirect URL; we store SHA-256(code) as bytea.
 *
 * Codes are PKCE-bound (code_challenge stored at /authorize, code_verifier
 * provided at /token). 10-minute TTL. `used_at` makes the code single-use —
 * a replay yields no row.
 */

import type { Queryable } from '../pool.js';

export interface OAuthAuthorizationRow {
  codeHash: Uint8Array;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string | null;
  state: string | null;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export interface InsertAuthorizationInput {
  codeHash: Uint8Array;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod?: string;
  scope?: string | null;
  state?: string | null;
  expiresAt: Date;
}

export async function insertOAuthAuthorization(
  db: Queryable,
  input: InsertAuthorizationInput,
): Promise<OAuthAuthorizationRow> {
  const res = await db.query<RawRow>(
    `INSERT INTO oauth_authorizations
       (code_hash, client_id, user_id, redirect_uri,
        code_challenge, code_challenge_method, scope, state, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING code_hash, client_id, user_id, redirect_uri,
               code_challenge, code_challenge_method, scope, state,
               expires_at, used_at, created_at`,
    [
      Buffer.from(input.codeHash),
      input.clientId,
      input.userId,
      input.redirectUri,
      input.codeChallenge,
      input.codeChallengeMethod ?? 'S256',
      input.scope ?? null,
      input.state ?? null,
      input.expiresAt,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('insertOAuthAuthorization: no row returned');
  return toRow(row);
}

export async function findAuthorizationByCodeHash(
  db: Queryable,
  codeHash: Uint8Array,
): Promise<OAuthAuthorizationRow | null> {
  const res = await db.query<RawRow>(
    `SELECT code_hash, client_id, user_id, redirect_uri,
            code_challenge, code_challenge_method, scope, state,
            expires_at, used_at, created_at
       FROM oauth_authorizations WHERE code_hash = $1`,
    [Buffer.from(codeHash)],
  );
  const row = res.rows[0];
  return row ? toRow(row) : null;
}

/** Atomically mark a code used. Returns true if the row transitioned from
 *  unused → used; false if it was already used (or doesn't exist). */
export async function markAuthorizationUsed(
  db: Queryable,
  codeHash: Uint8Array,
): Promise<boolean> {
  const res = await db.query(
    `UPDATE oauth_authorizations SET used_at = now()
      WHERE code_hash = $1 AND used_at IS NULL`,
    [Buffer.from(codeHash)],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function deleteExpiredAuthorizations(db: Queryable): Promise<number> {
  const res = await db.query(`DELETE FROM oauth_authorizations WHERE expires_at < now()`);
  return res.rowCount ?? 0;
}

interface RawRow {
  code_hash: Buffer;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string | null;
  state: string | null;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
}

function toRow(r: RawRow): OAuthAuthorizationRow {
  return {
    codeHash: new Uint8Array(r.code_hash),
    clientId: r.client_id,
    userId: r.user_id,
    redirectUri: r.redirect_uri,
    codeChallenge: r.code_challenge,
    codeChallengeMethod: r.code_challenge_method,
    scope: r.scope,
    state: r.state,
    expiresAt: r.expires_at,
    usedAt: r.used_at,
    createdAt: r.created_at,
  };
}
