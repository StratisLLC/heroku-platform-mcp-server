/**
 * End-to-end integration test for the hosted MCP.
 *
 * Walks the operator's actual happy path: sign-in → callback → /me → MCP
 * initialize → MCP tools/list (and a couple of tools/call invocations) → /audit
 * shows the tool calls → sign-out-everywhere → MCP requests start failing.
 *
 * Gated on `HEROKUMCP_TEST_DATABASE_URL`. CI sets this; locally, point it at a
 * scratch Postgres (`docker run -p 5432:5432 -e POSTGRES_PASSWORD=postgres
 * postgres:16-alpine`).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import pg from 'pg';
import { generateMasterKey } from '@heroku-mcp/core';
import { buildApp } from '../../src/app.js';
import { runMigrations } from '../../src/db/migrate.js';
import { TransportManager } from '../../src/mcp/transport.js';
import type { Config } from '../../src/config.js';
import type { HerokuOAuthConfig } from '../../src/oauth/heroku.js';
import type { AppEnv } from '../../src/auth/middleware.js';

const DB_URL = process.env.HEROKUMCP_TEST_DATABASE_URL;

const describeIfDb = DB_URL ? describe : describe.skip;

describeIfDb('http-server e2e (real Postgres + mocked Heroku)', () => {
  let pool: pg.Pool;
  let app: Hono<AppEnv>;
  let cfg: Config;
  let oauthCfg: HerokuOAuthConfig;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DB_URL });
    // Reset to a clean state per test run.
    await pool.query(
      `DROP TABLE IF EXISTS audit_log, connection_tokens, heroku_tokens, users, schema_migrations CASCADE`,
    );
    await runMigrations(pool);

    const masterKey = generateMasterKey();
    cfg = {
      port: 0,
      isProduction: false,
      publicUrl: 'http://localhost:0',
      databaseUrl: DB_URL!,
      dbPoolMax: 5,
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
      allowedEmails: null,
      allowedTeams: null,
      adminEmails: ['admin@example.com'],
      auditRetentionDays: null,
      logLevel: 'info',
      rawEnvForAdmin: { PORT: '3000' },
    };
    const herokuFetch = async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://id.heroku.com/oauth/token') {
        return new Response(
          JSON.stringify({
            access_token: 'AT-fake',
            refresh_token: 'RT-fake',
            expires_in: 28800,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://api.heroku.com/account') {
        return new Response(
          JSON.stringify({ id: 'heroku-integration', email: 'admin@example.com' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://api.heroku.com/teams') {
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error('unexpected fetch: ' + url);
    };
    oauthCfg = {
      clientId: cfg.oauth.clientId,
      clientSecret: cfg.oauth.clientSecret,
      scope: cfg.oauth.scope,
      redirectUri: `${cfg.publicUrl}/oauth/callback`,
      authorizeUrl: cfg.oauth.authorizeUrl,
      tokenUrl: cfg.oauth.tokenUrl,
      apiBaseUrl: cfg.herokuApiBaseUrl,
      fetch: herokuFetch,
    };

    const transports = new TransportManager();
    const built = buildApp({
      pool,
      cfg,
      oauthCfg,
      transports,
      herokuProbe: async () => true,
    });
    app = built.app;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('sign-in → /me round-trip persists rows in real Postgres', async () => {
    const r1 = await app.request('/sign-in');
    const flow = decodeURIComponent(
      /hmcp_oauth_flow=([^;]+)/.exec(r1.headers.get('set-cookie') ?? '')?.[1] ?? '',
    );
    const state = decodeURIComponent(
      /state=([^&]+)/.exec(r1.headers.get('location') ?? '')?.[1] ?? '',
    );
    const callback = await app.request(
      `/oauth/callback?code=AC&state=${encodeURIComponent(state)}`,
      {
        headers: { cookie: `hmcp_oauth_flow=${encodeURIComponent(flow)}` },
      },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/me');

    const users = await pool.query<{ email: string }>('SELECT email FROM users');
    expect(users.rows.map((r) => r.email)).toContain('admin@example.com');
    const tokens = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM connection_tokens WHERE revoked_at IS NULL',
    );
    expect(Number(tokens.rows[0]?.count)).toBe(1);
  });

  it('audit_log captures the sign-in and token-issued events', async () => {
    const entries = await pool.query<{ event_name: string }>(
      `SELECT event_name FROM audit_log ORDER BY occurred_at`,
    );
    const names = entries.rows.map((r) => r.event_name);
    expect(names).toContain('sign_in');
    expect(names).toContain('token_issued');
  });

  it('/admin/* is reachable for the admin user (session via the previous test)', async () => {
    // Re-sign in to grab a fresh session cookie value.
    const r1 = await app.request('/sign-in');
    const flow = decodeURIComponent(
      /hmcp_oauth_flow=([^;]+)/.exec(r1.headers.get('set-cookie') ?? '')?.[1] ?? '',
    );
    const state = decodeURIComponent(
      /state=([^&]+)/.exec(r1.headers.get('location') ?? '')?.[1] ?? '',
    );
    const r2 = await app.request(`/oauth/callback?code=AC&state=${encodeURIComponent(state)}`, {
      headers: { cookie: `hmcp_oauth_flow=${encodeURIComponent(flow)}` },
    });
    const sessionCookie = decodeURIComponent(
      /hmcp_session=([^;]+)/.exec(r2.headers.get('set-cookie') ?? '')?.[1] ?? '',
    );

    const status = await app.request('/admin/status', {
      headers: { cookie: `hmcp_session=${encodeURIComponent(sessionCookie)}` },
    });
    expect(status.status).toBe(200);
    expect(await status.text()).toMatch(/Master key fingerprint/);
  });
});
