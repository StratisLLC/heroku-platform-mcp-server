/**
 * `users` table CRUD. One row per Heroku account that ever signed in.
 * Updated on every sign-in (last_seen_at) and on every authenticated MCP
 * request via `touchLastSeen`.
 */

import type { Queryable } from '../pool.js';

export interface UserRow {
  id: string;
  herokuId: string;
  email: string;
  defaultTeam: string | null;
  signedInAt: Date;
  lastSeenAt: Date;
}

export interface UpsertUserInput {
  herokuId: string;
  email: string;
  defaultTeam: string | null;
}

/** Insert-or-update by heroku_id. Always advances `last_seen_at` and
 *  `signed_in_at` (sign-ins are the only call site). */
export async function upsertUser(db: Queryable, input: UpsertUserInput): Promise<UserRow> {
  const res = await db.query<RawUserRow>(
    `INSERT INTO users (heroku_id, email, default_team, signed_in_at, last_seen_at)
     VALUES ($1, $2, $3, now(), now())
     ON CONFLICT (heroku_id) DO UPDATE SET
       email = EXCLUDED.email,
       default_team = EXCLUDED.default_team,
       signed_in_at = now(),
       last_seen_at = now()
     RETURNING id, heroku_id, email, default_team, signed_in_at, last_seen_at`,
    [input.herokuId, input.email, input.defaultTeam],
  );
  const row = res.rows[0];
  if (!row) throw new Error('upsertUser: no row returned');
  return rowToUser(row);
}

export async function findUserById(db: Queryable, id: string): Promise<UserRow | null> {
  const res = await db.query<RawUserRow>(
    `SELECT id, heroku_id, email, default_team, signed_in_at, last_seen_at
       FROM users WHERE id = $1`,
    [id],
  );
  const row = res.rows[0];
  return row ? rowToUser(row) : null;
}

export async function findUserByEmail(db: Queryable, email: string): Promise<UserRow | null> {
  const res = await db.query<RawUserRow>(
    `SELECT id, heroku_id, email, default_team, signed_in_at, last_seen_at
       FROM users WHERE lower(email) = lower($1)
       ORDER BY last_seen_at DESC LIMIT 1`,
    [email],
  );
  const row = res.rows[0];
  return row ? rowToUser(row) : null;
}

export async function findUserByHerokuId(db: Queryable, herokuId: string): Promise<UserRow | null> {
  const res = await db.query<RawUserRow>(
    `SELECT id, heroku_id, email, default_team, signed_in_at, last_seen_at
       FROM users WHERE heroku_id = $1`,
    [herokuId],
  );
  const row = res.rows[0];
  return row ? rowToUser(row) : null;
}

export async function touchLastSeen(db: Queryable, id: string): Promise<void> {
  await db.query(`UPDATE users SET last_seen_at = now() WHERE id = $1`, [id]);
}

export async function listAllUsers(db: Queryable): Promise<UserRow[]> {
  const res = await db.query<RawUserRow>(
    `SELECT id, heroku_id, email, default_team, signed_in_at, last_seen_at
       FROM users ORDER BY last_seen_at DESC`,
  );
  return res.rows.map(rowToUser);
}

export async function deleteUser(db: Queryable, id: string): Promise<void> {
  await db.query(`DELETE FROM users WHERE id = $1`, [id]);
}

interface RawUserRow {
  id: string;
  heroku_id: string;
  email: string;
  default_team: string | null;
  signed_in_at: Date;
  last_seen_at: Date;
}

function rowToUser(r: RawUserRow): UserRow {
  return {
    id: r.id,
    herokuId: r.heroku_id,
    email: r.email,
    defaultTeam: r.default_team,
    signedInAt: r.signed_in_at,
    lastSeenAt: r.last_seen_at,
  };
}
