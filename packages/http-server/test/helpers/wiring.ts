/**
 * Wires up a Hono app against a fake Postgres + mocked Heroku fetch, suitable
 * for route-level testing.
 */

import type { Hono } from 'hono';
import { generateMasterKey } from '@heroku-mcp/core';
import { buildApp } from '../../src/app.js';
import { TransportManager } from '../../src/mcp/transport.js';
import { createFakePool, type FakePool } from './fake-pool.js';
import type { Config } from '../../src/config.js';
import type { AppEnv } from '../../src/auth/middleware.js';
import type { HerokuOAuthConfig } from '../../src/oauth/heroku.js';

export interface TestRig {
  app: Hono<AppEnv>;
  cfg: Config;
  pool: FakePool;
  transports: TransportManager;
  pendingTokens: Map<string, string>;
  oauthCfg: HerokuOAuthConfig;
}

export interface BuildRigOptions {
  allowedEmails?: string[] | null;
  allowedTeams?: string[] | null;
  adminEmails?: string[];
  herokuFetch?: typeof globalThis.fetch;
}

export function buildRig(opts: BuildRigOptions = {}): TestRig {
  const masterKey = generateMasterKey();
  const cfg: Config = {
    port: 0,
    isProduction: false,
    publicUrl: 'https://test.example.com',
    databaseUrl: 'postgres://fake',
    dbPoolMax: 1,
    dbSsl: 'off',
    masterKey,
    oauth: {
      clientId: 'cid',
      clientSecret: 'csec',
      scope: 'write-protected',
      authorizeUrl: 'https://id.heroku.com/oauth/authorize',
      tokenUrl: 'https://id.heroku.com/oauth/token',
    },
    herokuApiBaseUrl: 'https://api.heroku.com',
    adminContact: 'admin@example.com',
    allowedEmails: opts.allowedEmails ?? null,
    allowedTeams: opts.allowedTeams ?? null,
    adminEmails: opts.adminEmails ?? [],
    auditRetentionDays: null,
    logLevel: 'info',
    rawEnvForAdmin: { PORT: '3000' },
  };
  const oauthCfg: HerokuOAuthConfig = {
    clientId: cfg.oauth.clientId,
    clientSecret: cfg.oauth.clientSecret,
    scope: cfg.oauth.scope,
    redirectUri: `${cfg.publicUrl}/oauth/callback`,
    authorizeUrl: cfg.oauth.authorizeUrl,
    tokenUrl: cfg.oauth.tokenUrl,
    apiBaseUrl: cfg.herokuApiBaseUrl,
    ...(opts.herokuFetch ? { fetch: opts.herokuFetch } : {}),
  };
  const pool = createFakePool();
  const transports = new TransportManager();
  const pendingTokens = new Map<string, string>();
  const built = buildApp({
    // The repos receive only a `query` callback shape; the FakePool implements
    // it. TypeScript would normally complain about the `Pool` cast — we accept
    // it explicitly here for tests.
    pool: pool as unknown as import('pg').Pool,
    cfg,
    oauthCfg,
    transports,
    pendingTokens,
    herokuProbe: async () => true,
  });
  return { app: built.app, cfg, pool, transports, pendingTokens, oauthCfg };
}
