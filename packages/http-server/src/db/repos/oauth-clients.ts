/**
 * `oauth_clients` table CRUD. One row per DCR-registered OAuth client (e.g.
 * Claude Desktop). The client_secret plaintext is shown to the client once at
 * registration and never persisted — we store SHA-256(client_secret) as bytea.
 *
 * The `user_id` is nullable: it's bound on the first successful authorization
 * (when the client completes a code-grant flow on behalf of a specific user).
 * The /me "Connected applications" UI lists clients keyed by user_id.
 */

import type { Queryable } from '../pool.js';

export interface OAuthClientRow {
  clientId: string;
  clientSecretHash: Uint8Array;
  clientName: string | null;
  redirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: string;
  userId: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface InsertClientInput {
  clientId: string;
  clientSecretHash: Uint8Array;
  clientName?: string | null;
  redirectUris: string[];
  grantTypes?: string[];
  tokenEndpointAuthMethod?: string;
}

export async function insertOAuthClient(
  db: Queryable,
  input: InsertClientInput,
): Promise<OAuthClientRow> {
  const res = await db.query<RawRow>(
    `INSERT INTO oauth_clients
       (client_id, client_secret_hash, client_name, redirect_uris,
        grant_types, token_endpoint_auth_method)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING client_id, client_secret_hash, client_name, redirect_uris,
               grant_types, token_endpoint_auth_method, user_id,
               created_at, last_used_at, revoked_at`,
    [
      input.clientId,
      Buffer.from(input.clientSecretHash),
      input.clientName ?? null,
      input.redirectUris,
      input.grantTypes ?? ['authorization_code', 'refresh_token'],
      input.tokenEndpointAuthMethod ?? 'client_secret_basic',
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('insertOAuthClient: no row returned');
  return toRow(row);
}

export async function findOAuthClientById(
  db: Queryable,
  clientId: string,
): Promise<OAuthClientRow | null> {
  const res = await db.query<RawRow>(
    `SELECT client_id, client_secret_hash, client_name, redirect_uris,
            grant_types, token_endpoint_auth_method, user_id,
            created_at, last_used_at, revoked_at
       FROM oauth_clients WHERE client_id = $1`,
    [clientId],
  );
  const row = res.rows[0];
  return row ? toRow(row) : null;
}

export async function bindClientToUser(
  db: Queryable,
  clientId: string,
  userId: string,
): Promise<void> {
  await db.query(
    `UPDATE oauth_clients SET user_id = $2, last_used_at = now()
      WHERE client_id = $1`,
    [clientId, userId],
  );
}

export async function touchClientLastUsed(db: Queryable, clientId: string): Promise<void> {
  await db.query(`UPDATE oauth_clients SET last_used_at = now() WHERE client_id = $1`, [clientId]);
}

export async function revokeOAuthClient(db: Queryable, clientId: string): Promise<void> {
  await db.query(
    `UPDATE oauth_clients SET revoked_at = now()
      WHERE client_id = $1 AND revoked_at IS NULL`,
    [clientId],
  );
}

export async function listClientsForUser(
  db: Queryable,
  userId: string,
  opts: { includeRevoked?: boolean } = {},
): Promise<OAuthClientRow[]> {
  const where = opts.includeRevoked ? '' : 'AND revoked_at IS NULL';
  const res = await db.query<RawRow>(
    `SELECT client_id, client_secret_hash, client_name, redirect_uris,
            grant_types, token_endpoint_auth_method, user_id,
            created_at, last_used_at, revoked_at
       FROM oauth_clients
      WHERE user_id = $1 ${where}
      ORDER BY created_at DESC`,
    [userId],
  );
  return res.rows.map(toRow);
}

interface RawRow {
  client_id: string;
  client_secret_hash: Buffer;
  client_name: string | null;
  redirect_uris: string[];
  grant_types: string[];
  token_endpoint_auth_method: string;
  user_id: string | null;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

function toRow(r: RawRow): OAuthClientRow {
  return {
    clientId: r.client_id,
    clientSecretHash: new Uint8Array(r.client_secret_hash),
    clientName: r.client_name,
    redirectUris: r.redirect_uris,
    grantTypes: r.grant_types,
    tokenEndpointAuthMethod: r.token_endpoint_auth_method,
    userId: r.user_id,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
  };
}
