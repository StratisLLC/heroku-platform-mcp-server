/**
 * Server bootstrap for `herokumcp-platform-server`. Imported only by the CLI
 * shim (bin/start.ts). Library consumers should import from `./index.js` and
 * call `buildApp` themselves.
 */

import { serve } from '@hono/node-server';
import { masterKeyFingerprint, scrubString } from '@heroku-mcp/core';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { TransportManager } from './mcp/transport.js';
import { buildApp } from './app.js';
import type { HerokuOAuthConfig } from './oauth/heroku.js';
import { pruneAuditEntries } from './db/repos/audit-log.js';

export const PACKAGE_VERSION = '1.1.0';

export async function main(): Promise<void> {
  const cfg = loadConfig();
  const pool = createPool({
    databaseUrl: cfg.databaseUrl,
    max: cfg.dbPoolMax,
    ssl: cfg.dbSsl,
  });

  try {
    const result = await runMigrations(pool, { log: (m) => log('info', m) });
    log('info', `migrations: applied=${result.applied.length}, skipped=${result.skipped.length}`);
  } catch (err) {
    log('error', `migration failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const oauthCfg: HerokuOAuthConfig = {
    clientId: cfg.oauth.clientId,
    clientSecret: cfg.oauth.clientSecret,
    scope: cfg.oauth.scope,
    // Lazily derived from cfg.publicUrl (resolver-backed). This getter is only
    // evaluated inside request handlers (sign-in / oauth callback), by which
    // point the public URL has been resolved from the first request — so we
    // never need to know the public hostname at boot.
    get redirectUri(): string {
      return `${cfg.publicUrl}/oauth/callback`;
    },
    authorizeUrl: cfg.oauth.authorizeUrl,
    tokenUrl: cfg.oauth.tokenUrl,
    apiBaseUrl: cfg.herokuApiBaseUrl,
    userAgent: `herokumcp-http/${PACKAGE_VERSION}`,
  };

  const transports = new TransportManager();
  transports.startGc();

  const { app } = buildApp({
    pool,
    cfg,
    oauthCfg,
    transports,
    version: PACKAGE_VERSION,
  });

  if (cfg.auditRetentionDays !== null) {
    const days = cfg.auditRetentionDays;
    const intervalMs = 24 * 60 * 60 * 1000;
    const tick = async (): Promise<void> => {
      try {
        const before = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const n = await pruneAuditEntries(pool, { before });
        log('info', `audit prune: removed ${n} rows older than ${days}d`);
      } catch (err) {
        log('warn', `audit prune failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    const timer = setInterval(() => void tick(), intervalMs);
    timer.unref();
  }

  log(
    'info',
    `herokumcp-platform-server v${PACKAGE_VERSION} starting on :${cfg.port} (master-key fp ${masterKeyFingerprint(cfg.masterKey)})`,
  );
  const resolvedUrl = cfg.publicUrlResolver.peek();
  log(
    'info',
    resolvedUrl
      ? `public URL: ${resolvedUrl} (${cfg.publicUrlResolver.source()})`
      : 'public URL: will be resolved from the first inbound request',
  );

  const server = serve({
    fetch: app.fetch,
    port: cfg.port,
  });

  const shutdown = (signal: string): void => {
    log('info', `received ${signal}, shutting down`);
    server.close(() => {
      transports.stopGc();
      void pool.end().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

function log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
  const line = `[${new Date().toISOString()}] [${level}] ${scrubString(message)}`;
  if (level === 'error') console.error(line);
  else console.warn(line);
}
