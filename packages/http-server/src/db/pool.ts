/**
 * Single pg.Pool wrapper. We intentionally keep this thin — repos take a
 * `Queryable` (Pool or PoolClient) so transactions can pass a client through.
 */

import pg from 'pg';

export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export interface PoolOptions {
  databaseUrl: string;
  max?: number;
  /**
   *  - `require`    enable TLS, verify the cert
   *  - `no-verify`  enable TLS, accept self-signed (Heroku Postgres uses this)
   *  - `off`        no TLS (local docker only)
   */
  ssl?: 'require' | 'no-verify' | 'off';
}

export function createPool(opts: PoolOptions): pg.Pool {
  const sslConfig =
    opts.ssl === 'off'
      ? false
      : opts.ssl === 'no-verify'
        ? { rejectUnauthorized: false }
        : { rejectUnauthorized: true };
  return new pg.Pool({
    connectionString: opts.databaseUrl,
    max: opts.max ?? 10,
    ssl: sslConfig,
  });
}

/** Run `fn` inside a single connection with a BEGIN/COMMIT block. Rolls back
 *  on any thrown error and re-throws. */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // best-effort
    }
    throw err;
  } finally {
    client.release();
  }
}
