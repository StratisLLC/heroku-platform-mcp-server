/**
 * Tiny migration runner. Reads `migrations/*.sql` in lexical order, applies
 * any not yet recorded in `schema_migrations`, in a transaction per file.
 *
 * The bootstrap file (0001_initial.sql) is special: it creates the
 * `schema_migrations` table. We therefore do not consult that table before
 * running 0001 — the first attempt always runs 0001 (which is idempotent via
 * `CREATE TABLE IF NOT EXISTS`), then we INSERT a row marking it applied.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { withTransaction } from './pool.js';

/** Where migrations live, relative to this file at runtime. Both the source
 *  tree and the bundled dist/ resolve relative to themselves. */
export function defaultMigrationsDir(metaUrl: string = import.meta.url): string {
  const here = dirname(fileURLToPath(metaUrl));
  // src/db/migrate.ts → ../../migrations; dist/index.js → ../migrations.
  // Both resolve from cwd by trying them in order at runtime.
  return join(here, '..', '..', 'migrations');
}

export interface RunMigrationsOptions {
  migrationsDir?: string;
  /** Receives one line per applied filename. Defaults to no-op. */
  log?: (msg: string) => void;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

const SCHEMA_MIGRATIONS_TABLE = 'schema_migrations';

/** Apply every migration not yet recorded. Idempotent — running twice is a
 *  no-op the second time. */
export async function runMigrations(
  pool: pg.Pool,
  opts: RunMigrationsOptions = {},
): Promise<MigrationResult> {
  const dir = opts.migrationsDir ?? (await resolveMigrationsDir());
  const log = opts.log ?? (() => undefined);
  const files = (await readdir(dir))
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));

  const applied: string[] = [];
  const skipped: string[] = [];

  // Step 1: handle the bootstrap file (or any "0001_*") specially. It MUST run
  // before we can consult schema_migrations.
  const first = files[0];
  if (first === undefined) return { applied, skipped };

  const firstSql = await readFile(join(dir, first), 'utf8');
  await pool.query(firstSql);
  const seenFirst = await isApplied(pool, first);
  if (!seenFirst) {
    await pool.query(`INSERT INTO ${SCHEMA_MIGRATIONS_TABLE}(filename) VALUES ($1)`, [first]);
    applied.push(first);
    log(`applied ${first}`);
  } else {
    skipped.push(first);
  }

  for (const filename of files.slice(1)) {
    if (await isApplied(pool, filename)) {
      skipped.push(filename);
      continue;
    }
    const sql = await readFile(join(dir, filename), 'utf8');
    await withTransaction(pool, async (client) => {
      await client.query(sql);
      await client.query(`INSERT INTO ${SCHEMA_MIGRATIONS_TABLE}(filename) VALUES ($1)`, [
        filename,
      ]);
    });
    applied.push(filename);
    log(`applied ${filename}`);
  }
  return { applied, skipped };
}

/** Return the list of migration filenames previously applied, in apply order. */
export async function listAppliedMigrations(pool: pg.Pool): Promise<string[]> {
  // If the table doesn't exist yet, nothing has been applied.
  const exists = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [SCHEMA_MIGRATIONS_TABLE],
  );
  if (!exists.rows[0]?.exists) return [];
  const res = await pool.query<{ filename: string }>(
    `SELECT filename FROM ${SCHEMA_MIGRATIONS_TABLE} ORDER BY applied_at, filename`,
  );
  return res.rows.map((r) => r.filename);
}

async function isApplied(pool: pg.Pool, filename: string): Promise<boolean> {
  const exists = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [SCHEMA_MIGRATIONS_TABLE],
  );
  if (!exists.rows[0]?.exists) return false;
  const res = await pool.query(
    `SELECT 1 FROM ${SCHEMA_MIGRATIONS_TABLE} WHERE filename = $1 LIMIT 1`,
    [filename],
  );
  return res.rowCount !== null && res.rowCount > 0;
}

/** Pick the migrations directory by trying common layouts:
 *    src/db/migrate.ts  → ../../migrations
 *    dist/index.js      → ../migrations
 */
async function resolveMigrationsDir(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', '..', 'migrations'),
    join(here, '..', 'migrations'),
    join(here, 'migrations'),
  ];
  // Try them in order — the first that has any *.sql wins.
  for (const dir of candidates) {
    try {
      const files = await readdir(dir);
      if (files.some((f) => f.endsWith('.sql'))) return dir;
    } catch {
      // try next
    }
  }
  throw new Error(
    `Could not locate migrations directory. Tried: ${candidates.join(', ')}. Set migrationsDir explicitly.`,
  );
}
