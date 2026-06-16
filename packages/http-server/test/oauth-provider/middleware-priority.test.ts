/**
 * bearerAuth middleware: OAuth tokens take priority over connection_tokens;
 * both work; 401 carries WWW-Authenticate with resource_metadata.
 */

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { generateMasterKey } from '@heroku-mcp/core';
import { bearerAuth, type AppEnv } from '../../src/auth/middleware.js';
import { PublicUrlResolver } from '../../src/public-url.js';
import { hashToken, mintConnectionToken, TOKEN_PREFIX } from '../../src/auth/connection-token.js';
import { createFakePool } from '../helpers/fake-pool.js';
import { insertOAuthClient } from '../../src/db/repos/oauth-clients.js';
import { insertOAuthToken } from '../../src/db/repos/oauth-tokens.js';
import { mintAccessToken, sha256Bytes } from '../../src/oauth-provider/token.js';

const PUBLIC_URL = 'https://test.example.com';

function makeApp() {
  const masterKey = generateMasterKey();
  const pool = createFakePool();
  const app = new Hono<AppEnv>();
  app.use(
    '/api/*',
    bearerAuth({
      pool: pool as never,
      masterKey,
      adminEmails: [],
      publicUrlResolver: new PublicUrlResolver({
        explicit: PUBLIC_URL,
        isProduction: true,
        port: 3000,
      }),
    }),
  );
  app.get('/api/echo', (c) => {
    const auth = c.get('auth')!;
    return c.json({ kind: auth.kind, user: auth.user.email });
  });
  return { app, pool };
}

async function seedUser(pool: ReturnType<typeof createFakePool>) {
  return pool.store.upsertUser({
    heroku_id: 'h1',
    email: 'alice@example.com',
    default_team: null,
  });
}

async function seedConnectionToken(
  pool: ReturnType<typeof createFakePool>,
  userId: string,
  hash: Uint8Array,
) {
  await pool.query(
    `INSERT INTO connection_tokens (user_id, token_hash, label)
     VALUES ($1, $2, $3)
     RETURNING id, user_id, token_hash, label, issued_at, last_used_at, revoked_at`,
    [userId, Buffer.from(hash), null],
  );
}

describe('bearerAuth — OAuth-token path (oauth_tokens)', () => {
  it('accepts a valid OAuth access token and reports kind=oauth', async () => {
    const { app, pool } = makeApp();
    const user = await seedUser(pool);
    await insertOAuthClient(pool as never, {
      clientId: 'c1',
      clientSecretHash: sha256Bytes('s'),
      redirectUris: ['https://x/cb'],
    });
    const access = mintAccessToken();
    await insertOAuthToken(pool as never, {
      accessTokenHash: sha256Bytes(access),
      refreshTokenHash: sha256Bytes('refresh-' + Math.random()),
      clientId: 'c1',
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
      refreshExpiresAt: new Date(Date.now() + 60_000),
    });

    const res = await app.request('/api/echo', {
      headers: { authorization: `Bearer ${access}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; user: string };
    expect(body).toEqual({ kind: 'oauth', user: 'alice@example.com' });
  });

  it('rejects an expired OAuth access token', async () => {
    const { app, pool } = makeApp();
    const user = await seedUser(pool);
    await insertOAuthClient(pool as never, {
      clientId: 'c1',
      clientSecretHash: sha256Bytes('s'),
      redirectUris: ['https://x/cb'],
    });
    const access = mintAccessToken();
    await insertOAuthToken(pool as never, {
      accessTokenHash: sha256Bytes(access),
      refreshTokenHash: sha256Bytes('refresh-' + Math.random()),
      clientId: 'c1',
      userId: user.id,
      expiresAt: new Date(Date.now() - 1000),
      refreshExpiresAt: new Date(Date.now() + 60_000),
    });

    const res = await app.request('/api/echo', {
      headers: { authorization: `Bearer ${access}` },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a revoked OAuth access token', async () => {
    const { app, pool } = makeApp();
    const user = await seedUser(pool);
    await insertOAuthClient(pool as never, {
      clientId: 'c1',
      clientSecretHash: sha256Bytes('s'),
      redirectUris: ['https://x/cb'],
    });
    const access = mintAccessToken();
    await insertOAuthToken(pool as never, {
      accessTokenHash: sha256Bytes(access),
      refreshTokenHash: sha256Bytes('refresh-' + Math.random()),
      clientId: 'c1',
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
      refreshExpiresAt: new Date(Date.now() + 60_000),
    });
    pool.store.oauthTokens[0]!.revoked_at = new Date();

    const res = await app.request('/api/echo', {
      headers: { authorization: `Bearer ${access}` },
    });
    expect(res.status).toBe(401);
  });
});

describe('bearerAuth — fallback to connection_tokens', () => {
  it('accepts a Phase 4 bearer token when oauth_tokens has no match', async () => {
    const { app, pool } = makeApp();
    const user = await seedUser(pool);
    const t = mintConnectionToken();
    await seedConnectionToken(pool, user.id, t.hash);

    const res = await app.request('/api/echo', {
      headers: { authorization: `Bearer ${t.plaintext}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; user: string };
    expect(body).toEqual({ kind: 'bearer', user: 'alice@example.com' });
  });
});

describe('bearerAuth — 401 attaches WWW-Authenticate with resource_metadata', () => {
  it('on missing token', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/echo');
    expect(res.status).toBe(401);
    const h = res.headers.get('www-authenticate') ?? '';
    expect(h).toMatch(/^Bearer /);
    expect(h).toContain(`resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`);
  });

  it('on unknown token', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/echo', {
      headers: { authorization: `Bearer ${TOKEN_PREFIX}unknownXXXXXXXXXXXXXXX` },
    });
    expect(res.status).toBe(401);
    const h = res.headers.get('www-authenticate') ?? '';
    expect(h).toContain('resource_metadata=');
  });
});

describe('bearerAuth — priority', () => {
  it('OAuth token lookup runs FIRST: an oauth_tokens hit takes precedence over a connection_tokens hash collision', async () => {
    // Construct an unlikely but well-defined scenario: insert a
    // connection_tokens row AND an oauth_tokens row sharing the same hash.
    // Because the middleware tries oauth first, the principal should be
    // kind=oauth (and the connection-tokens last_used_at should NOT be
    // touched).
    const { app, pool } = makeApp();
    const user = await seedUser(pool);
    await insertOAuthClient(pool as never, {
      clientId: 'c1',
      clientSecretHash: sha256Bytes('s'),
      redirectUris: ['https://x/cb'],
    });
    const access = mintAccessToken();
    const hash = hashToken(access);
    await insertOAuthToken(pool as never, {
      accessTokenHash: hash,
      refreshTokenHash: sha256Bytes('refresh-' + Math.random()),
      clientId: 'c1',
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
      refreshExpiresAt: new Date(Date.now() + 60_000),
    });
    await seedConnectionToken(pool, user.id, hash);

    const res = await app.request('/api/echo', {
      headers: { authorization: `Bearer ${access}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string };
    expect(body.kind).toBe('oauth');
    // connection_tokens row should NOT have been touched.
    expect(pool.store.connectionTokens[0]?.last_used_at).toBeNull();
  });
});
