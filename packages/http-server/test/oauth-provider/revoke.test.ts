/**
 * /oauth/revoke endpoint tests (RFC 7009).
 */

import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { buildRig } from '../helpers/wiring.js';
import {
  sealSession,
  WEB_SESSION_COOKIE,
  WEB_SESSION_TTL_MS,
  type WebSessionData,
} from '../../src/auth/session.js';

function basicAuth(clientId: string, clientSecret: string): string {
  return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

function sha(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

async function register(rig: ReturnType<typeof buildRig>) {
  const res = await rig.app.request('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'X', redirect_uris: ['https://x/cb'] }),
  });
  return (await res.json()) as { client_id: string; client_secret: string };
}

async function fullExchange(rig: ReturnType<typeof buildRig>) {
  const { client_id, client_secret } = await register(rig);
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const user = rig.pool.store.upsertUser({
    heroku_id: 'h-' + Math.random(),
    email: 'u@example.com',
    default_team: null,
  });
  const sealed = sealSession<WebSessionData>(
    { userId: user.id, signedInAt: Date.now() },
    WEB_SESSION_TTL_MS,
    rig.cfg.masterKey,
  );
  const url = new URL('/oauth/authorize', 'http://x');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client_id);
  url.searchParams.set('redirect_uri', 'https://x/cb');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  const authRes = await rig.app.request(url.pathname + url.search, {
    headers: { cookie: `${WEB_SESSION_COOKIE}=${encodeURIComponent(sealed)}` },
  });
  const loc = new URL(authRes.headers.get('location') ?? '');
  const code = loc.searchParams.get('code')!;

  const tokenRes = await rig.app.request('/oauth/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: basicAuth(client_id, client_secret),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://x/cb',
      code_verifier: verifier,
    }).toString(),
  });
  const tk = (await tokenRes.json()) as { access_token: string; refresh_token: string };
  return { client_id, client_secret, ...tk };
}

async function postRevoke(
  rig: ReturnType<typeof buildRig>,
  body: Record<string, string>,
  authHeader?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (authHeader) headers.authorization = authHeader;
  return rig.app.request('/oauth/revoke', {
    method: 'POST',
    headers,
    body: new URLSearchParams(body).toString(),
  });
}

describe('POST /oauth/revoke', () => {
  it('revokes by access_token (no hint), returns 200', async () => {
    const rig = buildRig({ allowedEmails: ['u@example.com'] });
    const t = await fullExchange(rig);

    const res = await postRevoke(
      rig,
      { token: t.access_token },
      basicAuth(t.client_id, t.client_secret),
    );
    expect(res.status).toBe(200);
    const row = rig.pool.store.oauthTokens.find((x) =>
      x.access_token_hash.equals(sha(t.access_token)),
    );
    expect(row?.revoked_at).toBeInstanceOf(Date);
  });

  it('revokes by refresh_token (with hint)', async () => {
    const rig = buildRig({ allowedEmails: ['u@example.com'] });
    const t = await fullExchange(rig);

    const res = await postRevoke(
      rig,
      { token: t.refresh_token, token_type_hint: 'refresh_token' },
      basicAuth(t.client_id, t.client_secret),
    );
    expect(res.status).toBe(200);
    const row = rig.pool.store.oauthTokens.find((x) =>
      x.refresh_token_hash.equals(sha(t.refresh_token)),
    );
    expect(row?.revoked_at).toBeInstanceOf(Date);
  });

  it('returns 200 even for unknown tokens (RFC 7009 idempotency)', async () => {
    const rig = buildRig();
    const { client_id, client_secret } = await register(rig);
    const res = await postRevoke(
      rig,
      { token: 'hmcp_unknown' },
      basicAuth(client_id, client_secret),
    );
    expect(res.status).toBe(200);
  });

  it('returns 200 on a second revoke of the same token (idempotent)', async () => {
    const rig = buildRig({ allowedEmails: ['u@example.com'] });
    const t = await fullExchange(rig);

    await postRevoke(rig, { token: t.access_token }, basicAuth(t.client_id, t.client_secret));
    const second = await postRevoke(
      rig,
      { token: t.access_token },
      basicAuth(t.client_id, t.client_secret),
    );
    expect(second.status).toBe(200);
  });

  it('does NOT revoke a token belonging to a different client', async () => {
    const rig = buildRig({ allowedEmails: ['u@example.com'] });
    const t = await fullExchange(rig);
    const other = await register(rig);

    const res = await postRevoke(
      rig,
      { token: t.access_token },
      basicAuth(other.client_id, other.client_secret),
    );
    // RFC 7009 says respond 200 even when nothing matched; we should NOT
    // have revoked the other client's token.
    expect(res.status).toBe(200);
    const row = rig.pool.store.oauthTokens.find((x) =>
      x.access_token_hash.equals(sha(t.access_token)),
    );
    expect(row?.revoked_at).toBeNull();
  });

  it('401 when no client credentials are presented', async () => {
    const rig = buildRig();
    const res = await postRevoke(rig, { token: 'hmcp_x' });
    expect(res.status).toBe(401);
  });

  it('400 invalid_request when token field is missing', async () => {
    const rig = buildRig();
    const { client_id, client_secret } = await register(rig);
    const res = await postRevoke(rig, {}, basicAuth(client_id, client_secret));
    expect(res.status).toBe(400);
  });
});
