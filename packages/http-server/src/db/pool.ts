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
   *  - `require`    enable TLS; verify the cert, but auto-relax issuer
   *                 verification for Heroku-managed (AWS-hosted) Postgres
   *                 whose CA isn't in Node's trust store (see resolveSslConfig)
   *  - `no-verify`  enable TLS, accept self-signed (force-relax everywhere)
   *  - `off`        no TLS (local docker only)
   */
  ssl?: 'require' | 'no-verify' | 'off';
}

/**
 * Heroku provisions Postgres on AWS RDS (`*.amazonaws.com`) and presents a
 * certificate signed by a CA that isn't in Node's default trust store. With
 * strict verification the connection fails with "unable to get local issuer
 * certificate". `sslmode=disable` isn't an option either — Heroku Postgres
 * enforces SSL. The accepted remediation is to keep TLS on but skip issuer
 * verification (the channel is still encrypted in transit).
 */
export function isAwsHostedPostgres(databaseUrl: string): boolean {
  try {
    // `.amazonaws.com` also covers the `.compute-1.amazonaws.com` form.
    return new URL(databaseUrl).hostname.endsWith('.amazonaws.com');
  } catch {
    return false;
  }
}

/** Resolve pg's `ssl` option from the mode + connection string. An explicit
 *  `off`/`no-verify` always wins; the default `require` verifies the issuer
 *  except for AWS-hosted Postgres, where it relaxes verification automatically
 *  so a fresh Heroku deploy connects without manual config. */
export function resolveSslConfig(opts: PoolOptions): false | { rejectUnauthorized: boolean } {
  if (opts.ssl === 'off') return false;
  if (opts.ssl === 'no-verify') return { rejectUnauthorized: false };
  if (isAwsHostedPostgres(opts.databaseUrl)) return { rejectUnauthorized: false };
  return { rejectUnauthorized: true };
}

export function createPool(opts: PoolOptions): pg.Pool {
  return new pg.Pool({
    connectionString: opts.databaseUrl,
    max: opts.max ?? 10,
    ssl: resolveSslConfig(opts),
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
