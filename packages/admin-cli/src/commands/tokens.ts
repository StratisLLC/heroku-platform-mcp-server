import type { Command } from 'commander';
import { openPool } from '../shared/db.js';

interface TokenRow {
  id: string;
  email: string;
  label: string | null;
  issued_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

export function registerTokensCommands(parent: Command): void {
  const tokens = parent.command('tokens').description('Manage MCP connection tokens.');

  tokens
    .command('list')
    .description('List tokens (active by default).')
    .option('--include-revoked', 'Include revoked tokens.', false)
    .option('--database-url <url>', 'Postgres URL.')
    .action(async (opts: { includeRevoked: boolean; databaseUrl?: string }) => {
      const pool = openPool({ databaseUrl: opts.databaseUrl });
      try {
        const where = opts.includeRevoked ? '' : 'WHERE ct.revoked_at IS NULL';
        const res = await pool.query<TokenRow>(
          `SELECT ct.id, u.email, ct.label, ct.issued_at, ct.last_used_at, ct.revoked_at
             FROM connection_tokens ct LEFT JOIN users u ON u.id = ct.user_id
             ${where}
             ORDER BY ct.issued_at DESC`,
        );
        for (const r of res.rows) {
          const flag = r.revoked_at ? '[revoked]' : '[active]';
          process.stdout.write(
            `${flag} ${r.id}  ${r.email.padEnd(36)}  ${(r.label ?? '').padEnd(28)}  ` +
              `issued=${r.issued_at.toISOString()}  used=${r.last_used_at?.toISOString() ?? '-'}\n`,
          );
        }
        process.stdout.write(`\n${res.rowCount ?? 0} tokens\n`);
      } finally {
        await pool.end();
      }
    });

  tokens
    .command('revoke')
    .description('Revoke a single token by id.')
    .requiredOption('--id <id>', 'Connection-token UUID.')
    .option('--database-url <url>', 'Postgres URL.')
    .action(async (opts: { id: string; databaseUrl?: string }) => {
      const pool = openPool({ databaseUrl: opts.databaseUrl });
      try {
        const res = await pool.query(
          `UPDATE connection_tokens SET revoked_at = now()
            WHERE id = $1 AND revoked_at IS NULL`,
          [opts.id],
        );
        if ((res.rowCount ?? 0) === 0) {
          process.stderr.write('no active token with that id\n');
          process.exit(1);
        }
        process.stdout.write(`revoked ${opts.id}\n`);
      } finally {
        await pool.end();
      }
    });
}
