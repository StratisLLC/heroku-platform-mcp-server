import { describe, expect, it } from 'vitest';
import { buildRig } from '../helpers/wiring.js';

describe('public routes', () => {
  it('GET / shows the landing page with a sign-in button when not signed in', async () => {
    const { app } = buildRig();
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Sign in with Heroku');
  });

  it('GET /health returns {ok:true}', async () => {
    const { app } = buildRig();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('GET /sign-in redirects to Heroku and sets the flow cookie', async () => {
    const { app } = buildRig();
    const res = await app.request('/sign-in');
    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(location).toMatch(/^https:\/\/id\.heroku\.com\/oauth\/authorize\?/);
    expect(location).toContain('client_id=cid');
    expect(location).toContain('response_type=code');
    expect(location).toContain('code_challenge_method=S256');
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toMatch(/hmcp_oauth_flow=/);
    expect(setCookie).toContain('HttpOnly');
  });

  it('GET /oauth/callback rejects when the flow cookie is missing', async () => {
    const { app } = buildRig();
    const res = await app.request('/oauth/callback?code=AC&state=ST');
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toMatch(/expired|flow/i);
  });

  it('GET /oauth/callback surfaces Heroku-side OAuth errors', async () => {
    const { app } = buildRig();
    const res = await app.request(
      '/oauth/callback?error=access_denied&error_description=user+said+no',
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('user said no');
  });

  it('GET /oauth/callback with malformed params returns 400', async () => {
    const { app } = buildRig();
    const res = await app.request('/oauth/callback');
    expect(res.status).toBe(400);
  });

  it('POST /sign-out clears the cookie even when not signed in', async () => {
    const { app } = buildRig();
    const res = await app.request('/sign-out', { method: 'POST' });
    expect(res.status).toBe(302);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/hmcp_session=/);
    expect(setCookie).toContain('Max-Age=0');
  });
});

describe('/me redirects to /sign-in when not signed in', () => {
  it('redirects with a `next` param', async () => {
    const { app } = buildRig();
    const res = await app.request('/me');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/sign-in?next=/me');
  });
});

describe('/audit redirects to /sign-in when not signed in', () => {
  it('redirects', async () => {
    const { app } = buildRig();
    const res = await app.request('/audit');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/sign-in?next=/audit');
  });
});

describe('/admin/* returns 404 to unauthenticated callers', () => {
  it('hides admin pages from anonymous users', async () => {
    const { app } = buildRig();
    const res = await app.request('/admin/users');
    expect(res.status).toBe(404);
  });
});

describe('/mcp requires Bearer auth', () => {
  it('returns 401 with no auth header', async () => {
    const { app } = buildRig();
    const res = await app.request('/mcp', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { kind?: string } };
    expect(body.error?.kind).toBe('auth');
  });

  it('returns 401 with an unknown token', async () => {
    const { app } = buildRig();
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer hmcp_unknown', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });
});
