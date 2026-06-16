import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { generateMasterKey } from '@heroku-mcp/core';
import {
  bearerAuth,
  requireAdmin,
  requireWebAuth,
  webSessionAuth,
  type AppEnv,
} from '../src/auth/middleware.js';
import { hashToken, mintConnectionToken } from '../src/auth/connection-token.js';
import { PublicUrlResolver } from '../src/public-url.js';
import {
  sealSession,
  WEB_SESSION_COOKIE,
  WEB_SESSION_TTL_MS,
  type WebSessionData,
} from '../src/auth/session.js';
import { createFakePool } from './helpers/fake-pool.js';

function makeApp(adminEmails: string[] = []) {
  const masterKey = generateMasterKey();
  const pool = createFakePool();
  const app = new Hono<AppEnv>();
  const mwDeps = {
    pool: pool as never,
    masterKey,
    adminEmails,
    publicUrlResolver: new PublicUrlResolver({
      explicit: 'https://test.example.com',
      isProduction: true,
      port: 3000,
    }),
  };
  app.use('/web/*', webSessionAuth(mwDeps));
  app.use('/web/admin/*', requireAdmin());
  app.use('/web/me/*', requireWebAuth());
  app.use('/api/*', bearerAuth(mwDeps));
  app.get('/web/home', (c) =>
    c.text(c.get('auth') ? `signed-in ${c.get('auth')!.user.email}` : 'anon'),
  );
  app.get('/web/me/page', (c) => c.text('me-ok'));
  app.get('/web/admin/page', (c) => c.text('admin-ok'));
  app.get('/api/echo', (c) => c.json({ user: c.get('auth')?.user.email }));
  return { app, pool, masterKey };
}

describe('bearerAuth', () => {
  it('returns 401 with no header', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/echo');
    expect(res.status).toBe(401);
  });

  it('returns 401 with an invalid token', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/echo', {
      headers: { authorization: 'Bearer nope' },
    });
    expect(res.status).toBe(401);
  });

  it('passes through with a valid token', async () => {
    const { app, pool } = makeApp();
    const user = pool.store.upsertUser({
      heroku_id: 'h1',
      email: 'alice@example.com',
      default_team: null,
    });
    const t = mintConnectionToken();
    await pool.query(
      `INSERT INTO connection_tokens (user_id, token_hash, label)
       VALUES ($1, $2, $3)
       RETURNING id, user_id, token_hash, label, issued_at, last_used_at, revoked_at`,
      [user.id, Buffer.from(t.hash), null],
    );
    const res = await app.request('/api/echo', {
      headers: { authorization: `Bearer ${t.plaintext}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: 'alice@example.com' });
  });

  it('rejects a revoked token', async () => {
    const { app, pool } = makeApp();
    const user = pool.store.upsertUser({
      heroku_id: 'h1',
      email: 'alice@example.com',
      default_team: null,
    });
    const t = mintConnectionToken();
    await pool.query(
      `INSERT INTO connection_tokens (user_id, token_hash, label)
       VALUES ($1, $2, $3)
       RETURNING id, user_id, token_hash, label, issued_at, last_used_at, revoked_at`,
      [user.id, Buffer.from(t.hash), null],
    );
    // revoke
    pool.store.connectionTokens[0]!.revoked_at = new Date();
    const res = await app.request('/api/echo', {
      headers: { authorization: `Bearer ${t.plaintext}` },
    });
    expect(res.status).toBe(401);
  });
});

describe('webSessionAuth', () => {
  it('resolves anonymous when no cookie', async () => {
    const { app } = makeApp();
    const res = await app.request('/web/home');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('anon');
  });

  it('resolves the user from a sealed cookie', async () => {
    const { app, pool, masterKey } = makeApp();
    const user = pool.store.upsertUser({
      heroku_id: 'h1',
      email: 'alice@example.com',
      default_team: null,
    });
    const sealed = sealSession<WebSessionData>(
      { userId: user.id, signedInAt: Date.now() },
      WEB_SESSION_TTL_MS,
      masterKey,
    );
    const res = await app.request('/web/home', {
      headers: { cookie: `${WEB_SESSION_COOKIE}=${encodeURIComponent(sealed)}` },
    });
    expect(await res.text()).toBe('signed-in alice@example.com');
  });

  it('treats a sealed cookie with a deleted user as anonymous', async () => {
    const { app, masterKey } = makeApp();
    const sealed = sealSession<WebSessionData>(
      { userId: 'ghost', signedInAt: Date.now() },
      WEB_SESSION_TTL_MS,
      masterKey,
    );
    const res = await app.request('/web/home', {
      headers: { cookie: `${WEB_SESSION_COOKIE}=${encodeURIComponent(sealed)}` },
    });
    expect(await res.text()).toBe('anon');
  });
});

describe('requireWebAuth', () => {
  it('redirects to /sign-in when no session', async () => {
    const { app } = makeApp();
    const res = await app.request('/web/me/page');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/sign-in');
  });

  it('passes through for signed-in users', async () => {
    const { app, pool, masterKey } = makeApp();
    const user = pool.store.upsertUser({ heroku_id: 'h', email: 'a@b.com', default_team: null });
    const sealed = sealSession<WebSessionData>(
      { userId: user.id, signedInAt: Date.now() },
      WEB_SESSION_TTL_MS,
      masterKey,
    );
    const res = await app.request('/web/me/page', {
      headers: { cookie: `${WEB_SESSION_COOKIE}=${encodeURIComponent(sealed)}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('me-ok');
  });
});

describe('requireAdmin', () => {
  it('hides admin pages (404) from anonymous users', async () => {
    const { app } = makeApp(['admin@example.com']);
    const res = await app.request('/web/admin/page');
    expect(res.status).toBe(404);
  });

  it('hides admin pages from non-admin signed-in users', async () => {
    const { app, pool, masterKey } = makeApp(['admin@example.com']);
    const user = pool.store.upsertUser({
      heroku_id: 'h',
      email: 'normal@example.com',
      default_team: null,
    });
    const sealed = sealSession<WebSessionData>(
      { userId: user.id, signedInAt: Date.now() },
      WEB_SESSION_TTL_MS,
      masterKey,
    );
    const res = await app.request('/web/admin/page', {
      headers: { cookie: `${WEB_SESSION_COOKIE}=${encodeURIComponent(sealed)}` },
    });
    expect(res.status).toBe(404);
  });

  it('allows admins through', async () => {
    const { app, pool, masterKey } = makeApp(['admin@example.com']);
    const user = pool.store.upsertUser({
      heroku_id: 'h',
      email: 'admin@example.com',
      default_team: null,
    });
    const sealed = sealSession<WebSessionData>(
      { userId: user.id, signedInAt: Date.now() },
      WEB_SESSION_TTL_MS,
      masterKey,
    );
    const res = await app.request('/web/admin/page', {
      headers: { cookie: `${WEB_SESSION_COOKIE}=${encodeURIComponent(sealed)}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('admin-ok');
  });
});

// Silence the unused-import warning when hashToken isn't referenced via tests:
void hashToken;
