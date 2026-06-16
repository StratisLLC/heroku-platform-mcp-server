import type { Command } from 'commander';
import { openPool } from '../shared/db.js';

interface RawUser {
  id: string;
  heroku_id: string;
  email: string;
  last_seen_at: Date;
  active_tokens: string;
}

export function registerUsersCommands(parent: Command): void {
  const users = parent.command('users').description('List and inspect users.');

  users
    .command('list')
    .description('List every signed-in user.')
    .option('--database-url <url>', 'Postgres URL (overrides DATABASE_URL).')
    .action(async (opts: { databaseUrl?: string }) => {
      const pool = openPool({ databaseUrl: opts.databaseUrl });
      try {
        const res = await pool.query<RawUser>(
          `SELECT u.id, u.heroku_id, u.email, u.last_seen_at,
                  (SELECT count(*)::text FROM connection_tokens ct
                    WHERE ct.user_id = u.id AND ct.revoked_at IS NULL) AS active_tokens
             FROM users u ORDER BY u.last_seen_at DESC`,
        );
        for (const row of res.rows) {
          process.stdout.write(
            `${row.id}  ${row.email.padEnd(36)}  tokens=${row.active_tokens.padStart(3)}  last_seen=${row.last_seen_at.toISOString()}\n`,
          );
        }
        process.stdout.write(`\n${res.rowCount ?? 0} users\n`);
      } finally {
        await pool.end();
      }
    });

  users
    .command('revoke-all-tokens')
    .description('Revoke every active connection token for a user (by email).')
    .requiredOption('--email <email>', 'Target user email.')
    .option('--database-url <url>', 'Postgres URL.')
    .action(async (opts: { email: string; databaseUrl?: string }) => {
      const pool = openPool({ databaseUrl: opts.databaseUrl });
      try {
        const user = await pool.query<{ id: string }>(
          `SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`,
          [opts.email],
        );
        const row = user.rows[0];
        if (!row) {
          process.stderr.write(`no user with email ${opts.email}\n`);
          process.exit(1);
        }
        const res = await pool.query(
          `UPDATE connection_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
          [row.id],
        );
        process.stdout.write(`revoked ${res.rowCount ?? 0} tokens for ${opts.email}\n`);
      } finally {
        await pool.end();
      }
    });
}
