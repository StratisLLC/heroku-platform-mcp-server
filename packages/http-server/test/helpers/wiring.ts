/**
 * Wires up a Hono app against a fake Postgres + mocked Heroku fetch, suitable
 * for route-level testing.
 */

import type { Hono } from 'hono';
import {
  encodeForStorage,
  encryptWithDek,
  encryptWithKek,
  generateDek,
  generateMasterKey,
} from '@heroku-mcp/core';
import { buildApp } from '../../src/app.js';
import { TransportManager } from '../../src/mcp/transport.js';
import { createFakePool, type FakePool } from './fake-pool.js';
import type { Config } from '../../src/config.js';
import { PublicUrlResolver } from '../../src/public-url.js';
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
    publicUrlResolver: new PublicUrlResolver({
      explicit: 'https://test.example.com',
      isProduction: false,
      port: 0,
    }),
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

/**
 * Seed a usable (or deliberately-expired) encrypted Heroku token row for a user
 * straight into the fake store, encrypted under the rig's master key so
 * resolveUserAccessToken can decrypt it. Needed because /oauth/authorize now
 * re-validates the stored Heroku token before minting a code — a seeded web
 * session without a token row is redirected to /sign-in. Pass `expiresAt` in
 * the past to force a refresh attempt.
 */
export function seedHerokuToken(
  rig: TestRig,
  userId: string,
  opts: { expiresAt?: Date } = {},
): void {
  const dek = generateDek();
  const enc = (s: string): Buffer =>
    Buffer.from(encodeForStorage(encryptWithDek(new TextEncoder().encode(s), dek)));
  rig.pool.store.herokuTokens.push({
    user_id: userId,
    encrypted_access_token: enc('access-token'),
    encrypted_refresh_token: enc('refresh-token'),
    encrypted_dek: Buffer.from(encodeForStorage(encryptWithKek(dek, rig.cfg.masterKey))),
    expires_at: opts.expiresAt ?? new Date(Date.now() + 3_600_000),
    refreshed_at: new Date(),
  });
}
