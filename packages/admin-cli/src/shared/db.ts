/**
 * Connection-pool factory for the admin CLI. Reads DATABASE_URL from env
 * (or `--database-url`); exits with a clear message if missing.
 */

import pg from 'pg';

export interface DbOptions {
  databaseUrl?: string | undefined;
  sslMode?: 'require' | 'no-verify' | 'off';
}

export function openPool(opts: DbOptions = {}): pg.Pool {
  const url = opts.databaseUrl ?? process.env.DATABASE_URL;
  if (!url) {
    process.stderr.write('error: DATABASE_URL not set (or pass --database-url).\n');
    process.exit(2);
  }
  const sslMode =
    opts.sslMode ?? (process.env.HEROKUMCP_DB_SSL as DbOptions['sslMode']) ?? 'require';
  const ssl =
    sslMode === 'off'
      ? false
      : sslMode === 'no-verify'
        ? { rejectUnauthorized: false }
        : { rejectUnauthorized: true };
  return new pg.Pool({ connectionString: url, max: 5, ssl });
}
