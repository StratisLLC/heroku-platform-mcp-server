import type { Command } from 'commander';
import { masterKeyFingerprint, loadMasterKey } from '@heroku-mcp/core';
import { openPool } from '../shared/db.js';

export function registerStatusCommand(parent: Command): void {
  parent
    .command('status')
    .description('Print deployment health: DB reachability, token count, master-key fingerprint.')
    .option('--database-url <url>', 'Postgres URL.')
    .action(async (opts: { databaseUrl?: string }) => {
      const pool = openPool({ databaseUrl: opts.databaseUrl });
      try {
        let dbOk = false;
        try {
          await pool.query('SELECT 1');
          dbOk = true;
        } catch {
          dbOk = false;
        }
        const tokens = await pool.query<{ active: string; total: string }>(
          `SELECT
             count(*) FILTER (WHERE revoked_at IS NULL)::text AS active,
             count(*)::text AS total
           FROM connection_tokens`,
        );
        const users = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM users`,
        );
        const recentErr = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM audit_log
            WHERE status = 'error' AND occurred_at > now() - interval '24 hours'`,
        );
        process.stdout.write(`database:        ${dbOk ? 'reachable' : 'UNREACHABLE'}\n`);
        process.stdout.write(`users:           ${users.rows[0]?.count ?? '0'}\n`);
        process.stdout.write(
          `tokens:          ${tokens.rows[0]?.active ?? '0'} active / ${tokens.rows[0]?.total ?? '0'} total\n`,
        );
        process.stdout.write(`errors_24h:      ${recentErr.rows[0]?.count ?? '0'}\n`);
        const keyB64 = process.env.HEROKUMCP_MASTER_KEY;
        if (keyB64) {
          try {
            const k = loadMasterKey(keyB64);
            process.stdout.write(`master_key_fp:   ${masterKeyFingerprint(k)}\n`);
          } catch (err) {
            process.stdout.write(
              `master_key_fp:   ERROR (${err instanceof Error ? err.message : String(err)})\n`,
            );
          }
        } else {
          process.stdout.write('master_key_fp:   (HEROKUMCP_MASTER_KEY not set)\n');
        }
      } finally {
        await pool.end();
      }
    });
}
