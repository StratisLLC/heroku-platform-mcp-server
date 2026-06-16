import type { Command } from 'commander';
import { openPool } from '../shared/db.js';

interface AuditRow {
  occurred_at: Date;
  event_category: string;
  event_name: string;
  status: string;
  email: string | null;
  duration_ms: number | null;
  request_id: string | null;
}

export function registerAuditCommands(parent: Command): void {
  const audit = parent.command('audit').description('Query and prune the audit log.');

  audit
    .command('tail')
    .description('Print the most recent audit entries.')
    .option('--limit <n>', 'How many rows.', '50')
    .option('--email <email>', 'Restrict to a single user.')
    .option('--since <iso>', 'Only entries occurring at/after this ISO timestamp.')
    .option('--database-url <url>', 'Postgres URL.')
    .action(
      async (opts: { limit: string; email?: string; since?: string; databaseUrl?: string }) => {
        const pool = openPool({ databaseUrl: opts.databaseUrl });
        try {
          const where: string[] = [];
          const params: unknown[] = [];
          if (opts.email) {
            params.push(opts.email);
            where.push(`lower(u.email) = lower($${params.length})`);
          }
          if (opts.since) {
            params.push(opts.since);
            where.push(`al.occurred_at >= $${params.length}`);
          }
          const whereClause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
          const limit = Math.min(Math.max(1, Number.parseInt(opts.limit, 10) || 50), 10_000);
          const res = await pool.query<AuditRow>(
            `SELECT al.occurred_at, al.event_category, al.event_name, al.status,
                  u.email, al.duration_ms, al.request_id
             FROM audit_log al LEFT JOIN users u ON u.id = al.user_id
             ${whereClause}
             ORDER BY al.occurred_at DESC LIMIT ${limit}`,
            params,
          );
          for (const r of res.rows) {
            process.stdout.write(
              `${r.occurred_at.toISOString()}  ${r.status.padEnd(8)}  ${(r.email ?? '-').padEnd(28)}  ` +
                `${r.event_category}/${r.event_name}  dur=${r.duration_ms ?? '-'}ms\n`,
            );
          }
          process.stdout.write(`\n${res.rowCount ?? 0} entries\n`);
        } finally {
          await pool.end();
        }
      },
    );

  audit
    .command('prune')
    .description('Delete audit entries older than --before (ISO date).')
    .requiredOption('--before <iso>', 'Delete rows where occurred_at < this timestamp.')
    .option('--email <email>', 'Limit to a single user.')
    .option('--database-url <url>', 'Postgres URL.')
    .action(async (opts: { before: string; email?: string; databaseUrl?: string }) => {
      const pool = openPool({ databaseUrl: opts.databaseUrl });
      try {
        const cutoff = new Date(opts.before);
        if (Number.isNaN(cutoff.valueOf())) {
          process.stderr.write(`bad --before value: ${opts.before}\n`);
          process.exit(2);
        }
        if (opts.email) {
          const u = await pool.query<{ id: string }>(
            `SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`,
            [opts.email],
          );
          const row = u.rows[0];
          if (!row) {
            process.stderr.write(`no user with email ${opts.email}\n`);
            process.exit(1);
          }
          const res = await pool.query(
            `DELETE FROM audit_log WHERE user_id = $1 AND occurred_at < $2`,
            [row.id, cutoff],
          );
          process.stdout.write(`pruned ${res.rowCount ?? 0} rows for ${opts.email}\n`);
        } else {
          const res = await pool.query(`DELETE FROM audit_log WHERE occurred_at < $1`, [cutoff]);
          process.stdout.write(`pruned ${res.rowCount ?? 0} rows\n`);
        }
      } finally {
        await pool.end();
      }
    });
}
