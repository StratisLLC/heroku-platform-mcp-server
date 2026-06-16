/**
 * /oauth/authorize endpoint tests.
 *
 * Covers: query-param validation, client/redirect_uri checks, sign-in
 * redirect, consent screen render, allowlist short-circuit, and the
 * POST /oauth/consent handler (allow/deny).
 *
 * The authorize handler does NOT call Heroku directly — it relies on the
 * web session set by /oauth/callback. We seed a fake session cookie via
 * sealSession so we don't need to walk the full Heroku sign-in here.
 */

import { describe, expect, it } from 'vitest';
import { buildRig } from '../helpers/wiring.js';
import {
  sealSession,
  WEB_SESSION_COOKIE,
  WEB_SESSION_TTL_MS,
  type WebSessionData,
} from '../../src/auth/session.js';

const VALID_CHALLENGE = 'a'.repeat(43);

async function registerClient(
  app: import('hono').Hono<import('../../src/auth/middleware.js').AppEnv>,
  redirect_uris: string[] = ['https://claude.ai/oauth-callback'],
  client_name = 'Test Client',
): Promise<{ client_id: string; client_secret: string }> {
  const res = await app.request('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name, redirect_uris }),
  });
  return (await res.json()) as { client_id: string; client_secret: string };
}

function seedSession(rig: ReturnType<typeof buildRig>, email = 'u@example.com'): string {
  const user = rig.pool.store.upsertUser({
    heroku_id: 'h1',
    email,
    default_team: null,
  });
  const sealed = sealSession<WebSessionData>(
    { userId: user.id, signedInAt: Date.now() },
    WEB_SESSION_TTL_MS,
    rig.cfg.masterKey,
  );
  return `${WEB_SESSION_COOKIE}=${encodeURIComponent(sealed)}`;
}

function authorizeUrl(
  client_id: string,
  redirect_uri = 'https://claude.ai/oauth-callback',
  extra: Record<string, string> = {},
): string {
  const p = new URLSearchParams({
    response_type: 'code',
    client_id,
    redirect_uri,
    code_challenge: VALID_CHALLENGE,
    code_challenge_method: 'S256',
    ...extra,
  });
  return `/oauth/authorize?${p.toString()}`;
}

describe('GET /oauth/authorize — query validation', () => {
  it('400 when response_type is missing', async () => {
    const rig = buildRig();
    const { client_id } = await registerClient(rig.app);
    const u = new URL(authorizeUrl(client_id), 'http://x');
    u.searchParams.delete('response_type');
    const res = await rig.app.request(u.pathname + u.search);
    expect(res.status).toBe(400);
  });

  it('400 when code_challenge is too short', async () => {
    const rig = buildRig();
    const { client_id } = await registerClient(rig.app);
    const res = await rig.app.request(
      authorizeUrl(client_id, undefined, { code_challenge: 'short' }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when code_challenge_method != S256', async () => {
    const rig = buildRig();
    const { client_id } = await registerClient(rig.app);
    const res = await rig.app.request(
      authorizeUrl(client_id, undefined, { code_challenge_method: 'plain' }),
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /oauth/authorize — client / redirect_uri checks', () => {
  it('400 invalid_client when client_id is unknown', async () => {
    const rig = buildRig();
    const res = await rig.app.request(authorizeUrl('does-not-exist'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_client');
  });

  it('400 invalid_client when client is revoked', async () => {
    const rig = buildRig();
    const { client_id } = await registerClient(rig.app);
    const c = rig.pool.store.oauthClients.find((x) => x.client_id === client_id)!;
    c.revoked_at = new Date();
    const res = await rig.app.request(authorizeUrl(client_id));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_client');
  });

  it('400 invalid_redirect_uri when redirect_uri does not match a registered one', async () => {
    const rig = buildRig();
    const { client_id } = await registerClient(rig.app);
    const res = await rig.app.request(authorizeUrl(client_id, 'https://attacker.example/cb'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_redirect_uri');
  });
});

describe('GET /oauth/authorize — unauthenticated', () => {
  it('redirects to /sign-in with next= pointing back at /oauth/authorize', async () => {
    const rig = buildRig();
    const { client_id } = await registerClient(rig.app);
    const res = await rig.app.request(authorizeUrl(client_id));
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') ?? '';
    expect(loc.startsWith('/sign-in?next=')).toBe(true);
    expect(decodeURIComponent(loc)).toContain('/oauth/authorize?');
    expect(decodeURIComponent(loc)).toContain(`client_id=${client_id}`);
  });
});

describe('GET /oauth/authorize — authenticated, no allowlist (open deployment)', () => {
  it('renders the consent screen', async () => {
    const rig = buildRig();
    const cookie = seedSession(rig);
    const { client_id } = await registerClient(rig.app, undefined, 'Claude Desktop');
    const res = await rig.app.request(authorizeUrl(client_id, undefined, { state: 'XYZ' }), {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Claude Desktop');
    expect(body).toContain('Authorize application');
    expect(body).toContain(`value="${client_id}"`);
    expect(body).toContain('value="XYZ"');
  });
});

describe('GET /oauth/authorize — authenticated + email allowlisted', () => {
  it('skips consent and redirects with ?code= to the registered redirect_uri', async () => {
    const rig = buildRig({ allowedEmails: ['u@example.com'] });
    const cookie = seedSession(rig);
    const { client_id } = await registerClient(rig.app);
    const res = await rig.app.request(authorizeUrl(client_id, undefined, { state: 'S1' }), {
      headers: { cookie },
    });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location') ?? '');
    expect(loc.origin).toBe('https://claude.ai');
    expect(loc.pathname).toBe('/oauth-callback');
    expect(loc.searchParams.get('code')).toMatch(/^[0-9a-f]{32}$/);
    expect(loc.searchParams.get('state')).toBe('S1');

    // Authorization row was persisted with code_challenge.
    expect(rig.pool.store.oauthAuthorizations.length).toBe(1);
    expect(rig.pool.store.oauthAuthorizations[0]?.code_challenge).toBe(VALID_CHALLENGE);
    // And the client is now bound to the user.
    expect(rig.pool.store.oauthClients[0]?.user_id).toBeTruthy();
  });
});

describe('POST /oauth/consent', () => {
  it('decision=allow → mints code and redirects to the client', async () => {
    const rig = buildRig();
    const cookie = seedSession(rig);
    const { client_id } = await registerClient(rig.app);

    const form = new URLSearchParams({
      decision: 'allow',
      client_id,
      redirect_uri: 'https://claude.ai/oauth-callback',
      code_challenge: VALID_CHALLENGE,
      code_challenge_method: 'S256',
      state: 'S2',
    });
    const res = await rig.app.request('/oauth/consent', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location') ?? '');
    expect(loc.searchParams.get('code')).toMatch(/^[0-9a-f]{32}$/);
    expect(loc.searchParams.get('state')).toBe('S2');
  });

  it('decision=deny → redirects with error=access_denied and preserves state', async () => {
    const rig = buildRig();
    const cookie = seedSession(rig);
    const { client_id } = await registerClient(rig.app);

    const form = new URLSearchParams({
      decision: 'deny',
      client_id,
      redirect_uri: 'https://claude.ai/oauth-callback',
      code_challenge: VALID_CHALLENGE,
      code_challenge_method: 'S256',
      state: 'S3',
    });
    const res = await rig.app.request('/oauth/consent', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location') ?? '');
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('S3');
    expect(loc.searchParams.get('code')).toBeNull();
    expect(rig.pool.store.oauthAuthorizations.length).toBe(0);
  });

  it('unauthenticated consent POST → /sign-in', async () => {
    const rig = buildRig();
    const { client_id } = await registerClient(rig.app);
    const form = new URLSearchParams({
      decision: 'allow',
      client_id,
      redirect_uri: 'https://claude.ai/oauth-callback',
      code_challenge: VALID_CHALLENGE,
      code_challenge_method: 'S256',
    });
    const res = await rig.app.request('/oauth/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/sign-in');
  });

  it('rejects an unregistered redirect_uri at consent time', async () => {
    const rig = buildRig();
    const cookie = seedSession(rig);
    const { client_id } = await registerClient(rig.app);
    const form = new URLSearchParams({
      decision: 'allow',
      client_id,
      redirect_uri: 'https://attacker.example/cb',
      code_challenge: VALID_CHALLENGE,
      code_challenge_method: 'S256',
    });
    const res = await rig.app.request('/oauth/consent', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    expect(res.status).toBe(400);
  });
});
