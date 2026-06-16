import type { Command } from 'commander';
import { listAppliedMigrations, runMigrations } from '@heroku-mcp/http-server';
import { openPool } from '../shared/db.js';

export function registerDbCommands(parent: Command): void {
  const db = parent.command('db').description('Run / inspect schema migrations.');

  db.command('migrate')
    .description('Apply any pending migrations.')
    .option('--database-url <url>', 'Postgres URL.')
    .option('--dir <dir>', 'Migrations directory (default auto-detected).')
    .action(async (opts: { databaseUrl?: string; dir?: string }) => {
      const pool = openPool({ databaseUrl: opts.databaseUrl });
      try {
        const result = await runMigrations(pool, {
          ...(opts.dir !== undefined ? { migrationsDir: opts.dir } : {}),
          log: (m) => process.stdout.write(`${m}\n`),
        });
        process.stdout.write(
          `\napplied=${result.applied.length}, skipped=${result.skipped.length}\n`,
        );
      } finally {
        await pool.end();
      }
    });

  db.command('status')
    .description('Show applied migrations.')
    .option('--database-url <url>', 'Postgres URL.')
    .action(async (opts: { databaseUrl?: string }) => {
      const pool = openPool({ databaseUrl: opts.databaseUrl });
      try {
        const applied = await listAppliedMigrations(pool);
        if (applied.length === 0) {
          process.stdout.write('no migrations applied yet\n');
          return;
        }
        for (const m of applied) process.stdout.write(`${m}\n`);
      } finally {
        await pool.end();
      }
    });
}
