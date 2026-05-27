/**
 * `heroku_tokens` table CRUD. One row per user (PK = user_id). Stores the
 * user's Heroku OAuth tokens — both access and refresh — envelope-encrypted
 * with a per-user DEK that is itself wrapped by the master KEK.
 *
 * The repo deals only in opaque byte blobs (already-encoded envelopes). The
 * crypto layer above turns plaintext ↔ blob.
 */

import type { Queryable } from '../pool.js';

export interface HerokuTokenRow {
  userId: string;
  encryptedAccessToken: Uint8Array;
  encryptedRefreshToken: Uint8Array;
  encryptedDek: Uint8Array;
  expiresAt: Date;
  refreshedAt: Date;
}

export interface UpsertHerokuTokensInput {
  userId: string;
  encryptedAccessToken: Uint8Array;
  encryptedRefreshToken: Uint8Array;
  encryptedDek: Uint8Array;
  expiresAt: Date;
}

/** Upsert a user's Heroku token bundle. Resets refreshed_at to now(). */
export async function upsertHerokuTokens(
  db: Queryable,
  input: UpsertHerokuTokensInput,
): Promise<void> {
  await db.query(
    `INSERT INTO heroku_tokens
       (user_id, encrypted_access_token, encrypted_refresh_token, encrypted_dek,
        expires_at, refreshed_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (user_id) DO UPDATE SET
       encrypted_access_token = EXCLUDED.encrypted_access_token,
       encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
       encrypted_dek = EXCLUDED.encrypted_dek,
       expires_at = EXCLUDED.expires_at,
       refreshed_at = now()`,
    [
      input.userId,
      Buffer.from(input.encryptedAccessToken),
      Buffer.from(input.encryptedRefreshToken),
      Buffer.from(input.encryptedDek),
      input.expiresAt,
    ],
  );
}

export async function findHerokuTokens(
  db: Queryable,
  userId: string,
): Promise<HerokuTokenRow | null> {
  const res = await db.query<RawTokenRow>(
    `SELECT user_id, encrypted_access_token, encrypted_refresh_token,
            encrypted_dek, expires_at, refreshed_at
       FROM heroku_tokens WHERE user_id = $1`,
    [userId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    userId: row.user_id,
    encryptedAccessToken: new Uint8Array(row.encrypted_access_token),
    encryptedRefreshToken: new Uint8Array(row.encrypted_refresh_token),
    encryptedDek: new Uint8Array(row.encrypted_dek),
    expiresAt: row.expires_at,
    refreshedAt: row.refreshed_at,
  };
}

export async function deleteHerokuTokens(db: Queryable, userId: string): Promise<void> {
  await db.query(`DELETE FROM heroku_tokens WHERE user_id = $1`, [userId]);
}

interface RawTokenRow {
  user_id: string;
  encrypted_access_token: Buffer;
  encrypted_refresh_token: Buffer;
  encrypted_dek: Buffer;
  expires_at: Date;
  refreshed_at: Date;
}
