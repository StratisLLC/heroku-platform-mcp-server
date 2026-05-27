/**
 * Phase 4.5 — end-to-end OAuth provider flow against a real Postgres.
 *
 * Walks: register → authorize → /oauth/token → call /mcp → refresh →
 * call /mcp again with the new token → revoke → /mcp now 401.
 *
 * Heroku is stubbed (sign-in mocks the OAuth round-trip; the /mcp call
 * does not actually invoke a Heroku-backed tool — it only walks the
 * initialize handshake, which is enough to prove that the middleware
 * accepted the OAuth-issued token).
 *
 * Gated on `HEROKUMCP_TEST_DATABASE_URL` (same pattern as e2e).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import { createServer } from 'node:net';
import pg from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { generateMasterKey } from '@heroku-mcp/core';
import { buildApp } from '../../src/app.js';
import { runMigrations } from '../../src/db/migrate.js';
import { TransportManager } from '../../src/mcp/transport.js';
import type { Config } from '../../src/config.js';
import type { HerokuOAuthConfig } from '../../src/oauth/heroku.js';

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (typeof addr !== 'object' || addr === null) {
        srv.close();
        reject(new Error('no port'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

const DB_URL = process.env.HEROKUMCP_TEST_DATABASE_URL;
const describeIfDb = DB_URL ? describe : describe.skip;

function sha256b64url(s: string): string {
  return createHash('sha256').update(s).digest('base64url');
}

describeIfDb('OAuth provider end-to-end flow (real Postgres + mocked Heroku)', () => {
  let pool: pg.Pool;
  let baseUrl: string;
  let server: ServerType;
  let cfg: Config;
  let oauthCfg: HerokuOAuthConfig;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DB_URL });
    // Reset to a clean state per test run.
    await pool.query(
      `DROP TABLE IF EXISTS oauth_tokens, oauth_authorizations, oauth_clients,
        audit_log, connection_tokens, heroku_tokens, users, schema_migrations CASCADE`,
    );
    await runMigrations(pool);

    const masterKey = generateMasterKey();
    // Pre-pick a free port so publicUrl can be set before buildApp captures it.
    const port = await pickFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    cfg = {
      port,
      isProduction: false,
      publicUrl: baseUrl,
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
      allowedEmails: ['user@example.com'], // auto-allow → skips consent UI
      allowedTeams: null,
      adminEmails: [],
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
          JSON.stringify({ id: 'heroku-oauth-int', email: 'user@example.com' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://api.heroku.com/teams') {
        return new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
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
      fetch: herokuFetch,
    });

    // Start a real Node HTTP server so /mcp's transport.handleRequest gets
    // actual IncomingMessage/ServerResponse objects (Hono's app.request
    // doesn't supply them).
    await new Promise<void>((resolve) => {
      server = serve({ fetch: built.app.fetch, port: cfg.port, hostname: '127.0.0.1' }, () => {
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });

  function basic(clientId: string, secret: string): string {
    return 'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64');
  }

  function initBody(): string {
    return JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'integration-test', version: '0.0.1' },
      },
    });
  }

  it('register → authorize → token → /mcp → refresh → /mcp → revoke walks end-to-end', async () => {
    // 1) Sign the user in via the bearer-token flow (this seeds heroku_tokens
    //    so the /mcp call can later decrypt and use them).
    const r1 = await fetch(`${baseUrl}/sign-in`, { redirect: 'manual' });
    const flowCookie = decodeURIComponent(
      /hmcp_oauth_flow=([^;]+)/.exec(r1.headers.get('set-cookie') ?? '')?.[1] ?? '',
    );
    const state = decodeURIComponent(
      /state=([^&]+)/.exec(r1.headers.get('location') ?? '')?.[1] ?? '',
    );
    const callback = await fetch(
      `${baseUrl}/oauth/callback?code=AC&state=${encodeURIComponent(state)}`,
      {
        headers: { cookie: `hmcp_oauth_flow=${encodeURIComponent(flowCookie)}` },
        redirect: 'manual',
      },
    );
    expect(callback.status).toBe(302);
    const sessionCookie = decodeURIComponent(
      /hmcp_session=([^;]+)/.exec(callback.headers.get('set-cookie') ?? '')?.[1] ?? '',
    );

    // 2) DCR — register a fresh client.
    const regRes = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Claude Desktop (integration)',
        redirect_uris: ['https://claude.ai/oauth-callback'],
      }),
    });
    expect(regRes.status).toBe(201);
    const reg = (await regRes.json()) as { client_id: string; client_secret: string };

    // 3) Authorize.
    const verifier = randomBytes(48).toString('base64url');
    const challenge = sha256b64url(verifier);
    const authUrl = new URL('/oauth/authorize', baseUrl);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', reg.client_id);
    authUrl.searchParams.set('redirect_uri', 'https://claude.ai/oauth-callback');
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', 'S1');
    const authRes = await fetch(authUrl.toString(), {
      headers: { cookie: `hmcp_session=${encodeURIComponent(sessionCookie)}` },
      redirect: 'manual',
    });
    expect(authRes.status).toBe(302);
    const loc = new URL(authRes.headers.get('location') ?? '');
    expect(loc.origin).toBe('https://claude.ai');
    const code = loc.searchParams.get('code');
    expect(code).toBeTruthy();
    expect(loc.searchParams.get('state')).toBe('S1');

    // 4) Token exchange.
    const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: basic(reg.client_id, reg.client_secret),
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: 'https://claude.ai/oauth-callback',
        code_verifier: verifier,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
    };
    expect(tokens.access_token.startsWith('hmcp_')).toBe(true);
    expect(tokens.refresh_token.startsWith('hmcprt_')).toBe(true);
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.expires_in).toBe(3600);

    // 5) /mcp initialize.
    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: initBody(),
    });
    expect(initRes.status).toBe(200);
    expect(initRes.headers.get('mcp-session-id')).toBeTruthy();
    await initRes.body?.cancel();

    // 6) Refresh — rotation.
    const refreshRes = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: basic(reg.client_id, reg.client_secret),
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
      }).toString(),
    });
    expect(refreshRes.status).toBe(200);
    const fresh = (await refreshRes.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(fresh.access_token).not.toBe(tokens.access_token);
    expect(fresh.refresh_token).not.toBe(tokens.refresh_token);

    // 7) /mcp with the NEW access token.
    const initRes2 = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fresh.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: initBody(),
    });
    expect(initRes2.status).toBe(200);
    await initRes2.body?.cancel();

    // 8) Revoke.
    const revokeRes = await fetch(`${baseUrl}/oauth/revoke`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: basic(reg.client_id, reg.client_secret),
      },
      body: new URLSearchParams({ token: fresh.access_token }).toString(),
    });
    expect(revokeRes.status).toBe(200);

    const initRes3 = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fresh.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: initBody(),
    });
    expect(initRes3.status).toBe(401);
    expect(initRes3.headers.get('www-authenticate') ?? '').toContain('resource_metadata=');
    await initRes3.body?.cancel();
  });

  it('.well-known metadata documents render with the configured publicUrl', async () => {
    const md = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(md.status).toBe(200);
    const body = (await md.json()) as { issuer: string; token_endpoint: string };
    expect(body.issuer).toBe(baseUrl);
    expect(body.token_endpoint).toBe(`${baseUrl}/oauth/token`);

    const prm = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    expect(prm.status).toBe(200);
    const prmBody = (await prm.json()) as { resource: string };
    expect(prmBody.resource).toBe(`${baseUrl}/mcp`);
  });
});
