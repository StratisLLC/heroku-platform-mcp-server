/**
 * In-memory `pg.Pool` look-alike for route tests that need to avoid Postgres.
 *
 * Tracks: users, heroku_tokens, connection_tokens, audit_log, schema_migrations.
 * Only the SQL fragments our repos actually emit are recognised — we use the
 * SQL text as a discriminator, then operate on the in-memory store.
 *
 * This is good enough for route tests where we want to verify the wiring
 * (middleware, redirects, render shape) without standing up Postgres. The
 * integration test exercises real SQL against a real database.
 */

import { randomUUID } from 'node:crypto';

interface User {
  id: string;
  heroku_id: string;
  email: string;
  default_team: string | null;
  signed_in_at: Date;
  last_seen_at: Date;
}

interface HerokuToken {
  user_id: string;
  encrypted_access_token: Buffer;
  encrypted_refresh_token: Buffer;
  encrypted_dek: Buffer;
  expires_at: Date;
  refreshed_at: Date;
}

interface ConnectionToken {
  id: string;
  user_id: string;
  token_hash: Buffer;
  label: string | null;
  issued_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

interface AuditEntry {
  id: number;
  occurred_at: Date;
  user_id: string | null;
  event_category: string;
  event_name: string;
  status: string;
  request_id: string | null;
  duration_ms: number | null;
  client_name: string | null;
  client_version: string | null;
  details: Record<string, unknown> | null;
}

export class FakeStore {
  users: User[] = [];
  herokuTokens: HerokuToken[] = [];
  connectionTokens: ConnectionToken[] = [];
  auditLog: AuditEntry[] = [];
  appliedMigrations: string[] = [];
  private nextAuditId = 1;

  upsertUser(u: Omit<User, 'id' | 'signed_in_at' | 'last_seen_at'> & { id?: string }): User {
    const found = this.users.find((x) => x.heroku_id === u.heroku_id);
    if (found) {
      found.email = u.email;
      found.default_team = u.default_team ?? null;
      found.signed_in_at = new Date();
      found.last_seen_at = new Date();
      return found;
    }
    const user: User = {
      id: u.id ?? randomUUID(),
      heroku_id: u.heroku_id,
      email: u.email,
      default_team: u.default_team ?? null,
      signed_in_at: new Date(),
      last_seen_at: new Date(),
    };
    this.users.push(user);
    return user;
  }

  nextAuditEntryId(): number {
    return this.nextAuditId++;
  }
}

interface FakeQueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface FakePool {
  query<T = unknown>(text: string, values?: unknown[]): Promise<FakeQueryResult<T>>;
  end(): Promise<void>;
  connect(): Promise<FakeClient>;
  store: FakeStore;
}

export interface FakeClient {
  query: FakePool['query'];
  release(): void;
}

export function createFakePool(store: FakeStore = new FakeStore()): FakePool {
  const query = async <T = unknown>(
    text: string,
    values: unknown[] = [],
  ): Promise<FakeQueryResult<T>> => {
    const sql = text.trim();
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [] as T[], rowCount: 0 };
    }
    // ------------------------------------------------------------------
    // users
    // ------------------------------------------------------------------
    if (sql.startsWith('INSERT INTO users')) {
      const user = store.upsertUser({
        heroku_id: String(values[0]),
        email: String(values[1]),
        default_team: (values[2] as string | null) ?? null,
      });
      return { rows: [user] as T[], rowCount: 1 };
    }
    if (sql.startsWith('SELECT id, heroku_id, email, default_team')) {
      // Filter clause introspected by trailing WHERE.
      if (sql.includes('WHERE id =')) {
        const u = store.users.find((x) => x.id === String(values[0]));
        return { rows: u ? [u as unknown as T] : [], rowCount: u ? 1 : 0 };
      }
      if (sql.includes('lower(email) = lower($1)')) {
        const email = String(values[0]).toLowerCase();
        const u = store.users.find((x) => x.email.toLowerCase() === email);
        return { rows: u ? [u as unknown as T] : [], rowCount: u ? 1 : 0 };
      }
      if (sql.includes('WHERE heroku_id =')) {
        const u = store.users.find((x) => x.heroku_id === String(values[0]));
        return { rows: u ? [u as unknown as T] : [], rowCount: u ? 1 : 0 };
      }
      // listAllUsers
      const rows = [...store.users].sort(
        (a, b) => b.last_seen_at.valueOf() - a.last_seen_at.valueOf(),
      );
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (sql.startsWith('UPDATE users SET last_seen_at')) {
      const u = store.users.find((x) => x.id === String(values[0]));
      if (u) u.last_seen_at = new Date();
      return { rows: [] as T[], rowCount: u ? 1 : 0 };
    }
    if (sql.startsWith('DELETE FROM users')) {
      const before = store.users.length;
      store.users = store.users.filter((x) => x.id !== String(values[0]));
      return { rows: [] as T[], rowCount: before - store.users.length };
    }
    // ------------------------------------------------------------------
    // heroku_tokens
    // ------------------------------------------------------------------
    if (sql.startsWith('INSERT INTO heroku_tokens')) {
      const userId = String(values[0]);
      const existing = store.herokuTokens.findIndex((x) => x.user_id === userId);
      const row: HerokuToken = {
        user_id: userId,
        encrypted_access_token: Buffer.from(values[1] as Uint8Array),
        encrypted_refresh_token: Buffer.from(values[2] as Uint8Array),
        encrypted_dek: Buffer.from(values[3] as Uint8Array),
        expires_at: values[4] as Date,
        refreshed_at: new Date(),
      };
      if (existing >= 0) store.herokuTokens[existing] = row;
      else store.herokuTokens.push(row);
      return { rows: [] as T[], rowCount: 1 };
    }
    if (sql.startsWith('SELECT user_id, encrypted_access_token')) {
      const u = store.herokuTokens.find((x) => x.user_id === String(values[0]));
      return { rows: u ? [u as unknown as T] : [], rowCount: u ? 1 : 0 };
    }
    if (sql.startsWith('DELETE FROM heroku_tokens')) {
      const before = store.herokuTokens.length;
      store.herokuTokens = store.herokuTokens.filter((x) => x.user_id !== String(values[0]));
      return { rows: [] as T[], rowCount: before - store.herokuTokens.length };
    }
    // ------------------------------------------------------------------
    // connection_tokens
    // ------------------------------------------------------------------
    if (sql.startsWith('INSERT INTO connection_tokens')) {
      const row: ConnectionToken = {
        id: randomUUID(),
        user_id: String(values[0]),
        token_hash: Buffer.from(values[1] as Uint8Array),
        label: (values[2] as string | null) ?? null,
        issued_at: new Date(),
        last_used_at: null,
        revoked_at: null,
      };
      store.connectionTokens.push(row);
      return { rows: [row as unknown as T], rowCount: 1 };
    }
    if (sql.startsWith('SELECT id, user_id, token_hash')) {
      if (sql.includes('WHERE token_hash =')) {
        const hash = Buffer.from(values[0] as Uint8Array);
        const t = store.connectionTokens.find(
          (x) => x.revoked_at === null && x.token_hash.equals(hash),
        );
        return { rows: t ? [t as unknown as T] : [], rowCount: t ? 1 : 0 };
      }
      if (sql.includes('WHERE user_id =')) {
        const includeRevoked = !sql.includes('AND revoked_at IS NULL');
        const rows = store.connectionTokens
          .filter((x) => x.user_id === String(values[0]))
          .filter((x) => includeRevoked || x.revoked_at === null)
          .sort((a, b) => b.issued_at.valueOf() - a.issued_at.valueOf());
        return { rows: rows as unknown as T[], rowCount: rows.length };
      }
      // listAllTokens
      const includeRevoked = !sql.includes('WHERE revoked_at IS NULL');
      const rows = [...store.connectionTokens]
        .filter((x) => includeRevoked || x.revoked_at === null)
        .sort((a, b) => b.issued_at.valueOf() - a.issued_at.valueOf());
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (sql.startsWith('UPDATE connection_tokens SET last_used_at')) {
      const t = store.connectionTokens.find((x) => x.id === String(values[0]));
      if (t) t.last_used_at = new Date();
      return { rows: [] as T[], rowCount: t ? 1 : 0 };
    }
    if (sql.startsWith('UPDATE connection_tokens SET revoked_at')) {
      // Either by id or by user_id.
      if (sql.includes('WHERE id =')) {
        const t = store.connectionTokens.find(
          (x) => x.id === String(values[0]) && x.revoked_at === null,
        );
        if (t) t.revoked_at = new Date();
        return { rows: [] as T[], rowCount: t ? 1 : 0 };
      }
      // WHERE user_id = $1 AND revoked_at IS NULL
      let n = 0;
      for (const t of store.connectionTokens) {
        if (t.user_id === String(values[0]) && t.revoked_at === null) {
          t.revoked_at = new Date();
          n += 1;
        }
      }
      return { rows: [] as T[], rowCount: n };
    }
    if (sql.startsWith('SELECT count(*)::text AS count FROM connection_tokens')) {
      const userId = String(values[0]);
      const n = store.connectionTokens.filter(
        (x) => x.user_id === userId && x.revoked_at === null,
      ).length;
      return { rows: [{ count: String(n) }] as unknown as T[], rowCount: 1 };
    }
    // ------------------------------------------------------------------
    // audit_log
    // ------------------------------------------------------------------
    if (sql.startsWith('INSERT INTO audit_log')) {
      const entry: AuditEntry = {
        id: store.nextAuditEntryId(),
        occurred_at: new Date(),
        user_id: (values[0] as string | null) ?? null,
        event_category: String(values[1]),
        event_name: String(values[2]),
        status: String(values[3]),
        request_id: (values[4] as string | null) ?? null,
        duration_ms: (values[5] as number | null) ?? null,
        client_name: (values[6] as string | null) ?? null,
        client_version: (values[7] as string | null) ?? null,
        details: values[8] ? (JSON.parse(values[8] as string) as Record<string, unknown>) : null,
      };
      store.auditLog.push(entry);
      return { rows: [] as T[], rowCount: 1 };
    }
    if (sql.startsWith('SELECT count(*)::text AS count FROM audit_log')) {
      // Best-effort: just count all, since tests don't check filter behaviour.
      return {
        rows: [{ count: String(store.auditLog.length) }] as unknown as T[],
        rowCount: 1,
      };
    }
    if (sql.startsWith('SELECT id::text, occurred_at, user_id')) {
      const rows = [...store.auditLog]
        .map((e) => ({
          id: String(e.id),
          occurred_at: e.occurred_at,
          user_id: e.user_id,
          event_category: e.event_category,
          event_name: e.event_name,
          status: e.status,
          request_id: e.request_id,
          duration_ms: e.duration_ms,
          client_name: e.client_name,
          client_version: e.client_version,
          details: e.details,
        }))
        .sort((a, b) => b.occurred_at.valueOf() - a.occurred_at.valueOf());
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (sql.startsWith('DELETE FROM audit_log')) {
      // Tests don't verify the delete semantics in detail.
      const n = store.auditLog.length;
      store.auditLog = [];
      return { rows: [] as T[], rowCount: n };
    }
    // ------------------------------------------------------------------
    // probes / schema_migrations / generic
    // ------------------------------------------------------------------
    if (sql.startsWith('SELECT 1')) {
      return { rows: [{ '?column?': 1 }] as unknown as T[], rowCount: 1 };
    }
    if (sql.startsWith('SELECT to_regclass')) {
      return { rows: [{ exists: true }] as unknown as T[], rowCount: 1 };
    }
    if (sql.startsWith('SELECT filename FROM schema_migrations')) {
      return {
        rows: store.appliedMigrations.map((f) => ({ filename: f })) as unknown as T[],
        rowCount: store.appliedMigrations.length,
      };
    }
    throw new Error(`FakePool: unrecognised query: ${sql.slice(0, 120)}…`);
  };

  return {
    query,
    async end(): Promise<void> {
      await Promise.resolve();
    },
    async connect(): Promise<FakeClient> {
      return {
        query,
        release(): void {
          // no-op
        },
      };
    },
    store,
  };
}
