/**
 * /oauth/token endpoint tests — authorization_code + refresh_token grants.
 */

import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { buildRig, seedHerokuToken } from '../helpers/wiring.js';
import {
  sealSession,
  WEB_SESSION_COOKIE,
  WEB_SESSION_TTL_MS,
  type WebSessionData,
} from '../../src/auth/session.js';
import {
  ACCESS_TOKEN_PREFIX,
  REFRESH_TOKEN_PREFIX,
  sha256Bytes,
} from '../../src/oauth-provider/token.js';

function basicAuth(clientId: string, clientSecret: string): string {
  return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

interface PkcePair {
  verifier: string;
  challenge: string;
}

function pkcePair(): PkcePair {
  const verifier = randomBytes(48).toString('base64url'); // > 43 chars
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function register(
  app: import('hono').Hono<import('../../src/auth/middleware.js').AppEnv>,
): Promise<{ client_id: string; client_secret: string }> {
  const res = await app.request('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Test',
      redirect_uris: ['https://claude.ai/cb'],
    }),
  });
  return (await res.json()) as { client_id: string; client_secret: string };
}

async function getAuthCode(
  rig: ReturnType<typeof buildRig>,
  client_id: string,
  pkce: PkcePair,
  redirect_uri = 'https://claude.ai/cb',
): Promise<string> {
  // Seed an allowlisted session so the authorize call short-circuits past the
  // consent screen and returns ?code=.
  const user = rig.pool.store.upsertUser({
    heroku_id: 'h-' + Math.random(),
    email: 'u@example.com',
    default_team: null,
  });
  // /oauth/authorize re-validates the stored Heroku token before minting a code.
  seedHerokuToken(rig, user.id);
  const sealed = sealSession<WebSessionData>(
    { userId: user.id, signedInAt: Date.now() },
    WEB_SESSION_TTL_MS,
    rig.cfg.masterKey,
  );
  const url = new URL('/oauth/authorize', 'http://x');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client_id);
  url.searchParams.set('redirect_uri', redirect_uri);
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  const res = await rig.app.request(url.pathname + url.search, {
    headers: { cookie: `${WEB_SESSION_COOKIE}=${encodeURIComponent(sealed)}` },
  });
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get('location') ?? '');
  const code = loc.searchParams.get('code');
  expect(code).toBeTruthy();
  return code!;
}

async function postToken(
  rig: ReturnType<typeof buildRig>,
  body: Record<string, string>,
  authHeader?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (authHeader) headers.authorization = authHeader;
  return rig.app.request('/oauth/token', {
    method: 'POST',
    headers,
    body: new URLSearchParams(body).toString(),
  });
}

describe('POST /oauth/token — authorization_code grant', () => {
  it('happy path: returns access_token + refresh_token with correct shape', async () => {
    const rig = buildRig({ allowedEmails: ['u@example.com'] });
    const { client_id, client_secret } = await register(rig.app);
    const pkce = pkcePair();
    const code = await getAuthCode(rig, client_id, pkce);

    const res = await postToken(
      rig,
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://claude.ai/cb',
        code_verifier: pkce.verifier,
      },
      basicAuth(client_id, client_secret),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
    };
    expect(body.access_token.startsWith(ACCESS_TOKEN_PREFIX)).toBe(true);
    expect(body.refresh_token.startsWith(REFRESH_TOKEN_PREFIX)).toBe(true);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(3600);
    expect(body.scope).toBe('');

    // Token row was stored under the correct hashes.
    const accessHash = sha256Bytes(body.access_token);
    expect(rig.pool.store.oauthTokens[0]?.access_token_hash.equals(Buffer.from(accessHash))).toBe(
      true,
    );
    // Authorization row marked used.
    expect(rig.pool.store.oauthAuthorizations[0]?.used_at).toBeInstanceOf(Date);
  });

  it('accepts client_secret_post (credentials in form body)', async () => {
    const rig = buildRig({ allowedEmails: ['u@example.com'] });
    const { client_id, client_secret } = await register(rig.app);
    const pkce = pkcePair();
    const code = await getAuthCode(rig, client_id, pkce);

    const res = await postToken(rig, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://claude.ai/cb',
      code_verifier: pkce.verifier,
      client_id,
      client_secret,
    });
    expect(res.status).toBe(200);
  });

  it('401 invalid_client when client_secret is wrong', async () => {
    const rig = buildRig({ allowedEmails: ['u@example.com'] });
    const { client_id } = await register(rig.app);
    const pkce = pkcePair();
    const code = await getAuthCode(rig, client_id, pkce);

    const res = await postToken(
      rig,
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://claude.ai/cb',
        code_verifier: pkce.verifier,
      },
      basicAuth(client_id, 'WRONG-SECRET'),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_client');
  });

  it('401 invalid_client when no credentials are presented', async () => {
    const rig = buildRig();
    const res = await postToken(rig, { grant_type: 'authorization_code' });
    expect(res.status).toBe(401);
  });

  it('400 invalid_grant when code is unknown', async () => {
    const rig = buildRig();
    const { client_id, client_secret } = await register(rig.app);
    const pkce = pkcePair();
    const res = await postToken(
      rig,
      {
        grant_type: 'authorization_code',
        code: 'deadbeef',
        redirect_uri: 'https://claude.ai/cb',
        code_verifier: pkce.verifier,
      },
      basicAuth(client_id, client_secret),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_grant');
  });

  it('400 invalid_grant when code is replayed', async () => {
    const rig = buildRig({ allowedEmails: ['u@example.com'] });
    const { client_id, client_secret } = await register(rig.app);
    const pkce = pkcePair();
    const code = await getAuthCode(rig, client_id, pkce);

    const first = await postToken(
      rig,
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://claude.ai/cb',
        code_verifier: pkce.verifier,
      },
      basicAuth(client_id, client_secret),
    );
    expect(first.status).toBe(200);
    const replay = await postToken(
      rig,
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://claude.ai/cb',
        code_verifier: pkce.verifier,
      },
      basicAuth(client_id, client_secret),
    );
    expect(replay.status).toBe(400);
    const body = (await replay.json()) as { error: string; error_description: string };
    expect(body.error).toBe('invalid_grant');
    expect(body.error_description).toMatch(/already been used/);
  });

  it('400 invalid_grant when PKCE verifier does not match the stored challenge', async () => {
    const rig = buildRig({ allowedEmails: ['u@example.com'] });
    const { client_id, client_secret } = await register(rig.app);
    const pkce = pkcePair();
    const code = await getAuthCode(rig, client_id, pkce);

    // Submit a different verifier.
    const wrongVerifier = randomBytes(48).toString('base64url');
    const res = await postToken(
      rig,
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://claude.ai/cb',
        code_verifier: wrongVerifier,
      },
      basicAuth(client_id, client_secret),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe('invalid_grant');
    expect(body.error_description).toMatch(/PKCE/);
  });

  it('400 invalid_grant when redirect_uri does not match the authorization', async () => {
    const rig = buildRig({ allowedEmails: ['u@example.com'] });
    const { client_id, client_secret } = await register(rig.app);
    const pkce = pkcePair();
    const code = await getAuthCode(rig, client_id, pkce);

    const res = await postToken(
      rig,
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://attacker.example/cb',
        code_verifier: pkce.verifier,
      },
      basicAuth(client_id, client_secret),
    );
    expect(res.status).toBe(400);
  });

  it('400 invalid_grant when the code was issued to a different client', async () => {
    const rig = buildRig({ allowedEmails: ['u@example.com'] });
    const a = await register(rig.app);
    const b = await register(rig.app);
    const pkce = pkcePair();
    const code = await getAuthCode(rig, a.client_id, pkce);

    const res = await postToken(
      rig,
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://claude.ai/cb',
        code_verifier: pkce.verifier,
      },
      basicAuth(b.client_id, b.client_secret),
    );
    expect(res.status).toBe(400);
  });

  it('400 invalid_grant when the code has expired', async () => {
    const rig = buildRig({ allowedEmails: ['u@example.com'] });
    const { client_id, client_secret } = await register(rig.app);
    const pkce = pkcePair();
    const code = await getAuthCode(rig, client_id, pkce);

    // Force the stored authorization to be expired.
    rig.pool.store.oauthAuthorizations[0]!.expires_at = new Date(Date.now() - 1000);

    const res = await postToken(
      rig,
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://claude.ai/cb',
        code_verifier: pkce.verifier,
      },
      basicAuth(client_id, client_secret),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error_description: string };
    expect(body.error_description).toMatch(/expired/);
  });
});

describe('POST /oauth/token — refresh_token grant', () => {
  async function fullExchange(rig: ReturnType<typeof buildRig>) {
    const { client_id, client_secret } = await register(rig.app);
    const pkce = pkcePair();
    const code = await getAuthCode(rig, client_id, pkce);
    const r = await postToken(
      rig,
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://claude.ai/cb',
        code_verifier: pkce.verifier,
      },
      basicAuth(client_id, client_secret),
    );
    const body = (await r.json()) as { access_token: string; refresh_token: string };
    return { client_id, client_secret, ...body };
  }

  it('happy path: returns a NEW access/refresh pair and revokes the old refresh', async () => {
    const rig = buildRig({ allowedEmails: ['u@example.com'] });
    const old = await fullExchange(rig);

    const res = await postToken(
      rig,
      {
        grant_type: 'refresh_token',
        refresh_token: old.refresh_token,
      },
      basicAuth(old.client_id, old.client_secret),
    );
    expect(res.status).toBe(200);
    const fresh = (await res.json()) as { access_token: string; refresh_token: string };
    expect(fresh.access_token).not.toBe(old.access_token);
    expect(fresh.refresh_token).not.toBe(old.refresh_token);

    // Old refresh should now be revoked.
    const oldRefreshHash = sha256Bytes(old.refresh_token);
    const oldRow = rig.pool.store.oauthTokens.find((t) =>
      t.refresh_token_hash.equals(Buffer.from(oldRefreshHash)),
    );
    expect(oldRow?.revoked_at).toBeInstanceOf(Date);

    // New refresh is active.
    const newRefreshHash = sha256Bytes(fresh.refresh_token);
    const newRow = rig.pool.store.oauthTokens.find((t) =>
      t.refresh_token_hash.equals(Buffer.from(newRefreshHash)),
    );
    expect(newRow?.revoked_at).toBeNull();
  });

  it('400 invalid_grant when refresh_token is unknown', async () => {
    const rig = buildRig();
    const { client_id, client_secret } = await register(rig.app);
    const res = await postToken(
      rig,
      { grant_type: 'refresh_token', refresh_token: 'hmcprt_unknown' },
      basicAuth(client_id, client_secret),
    );
    expect(res.status).toBe(400);
  });

  it('400 invalid_grant when refresh_token was already used (revoked)', async () => {
    const rig = buildRig({ allowedEmails: ['u@example.com'] });
    const old = await fullExchange(rig);
    const first = await postToken(
      rig,
      { grant_type: 'refresh_token', refresh_token: old.refresh_token },
      basicAuth(old.client_id, old.client_secret),
    );
    expect(first.status).toBe(200);

    const replay = await postToken(
      rig,
      { grant_type: 'refresh_token', refresh_token: old.refresh_token },
      basicAuth(old.client_id, old.client_secret),
    );
    expect(replay.status).toBe(400);
    const body = (await replay.json()) as { error_description: string };
    expect(body.error_description).toMatch(/revoked/);
  });

  it('400 invalid_grant when refresh_token was issued to a different client', async () => {
    const rig = buildRig({ allowedEmails: ['u@example.com'] });
    const aTokens = await fullExchange(rig);
    const other = await register(rig.app);
    const res = await postToken(
      rig,
      { grant_type: 'refresh_token', refresh_token: aTokens.refresh_token },
      basicAuth(other.client_id, other.client_secret),
    );
    expect(res.status).toBe(400);
  });

  it('400 invalid_grant when refresh_token is expired', async () => {
    const rig = buildRig({ allowedEmails: ['u@example.com'] });
    const old = await fullExchange(rig);
    // Force the stored row to be expired.
    const refreshHash = sha256Bytes(old.refresh_token);
    const row = rig.pool.store.oauthTokens.find((t) =>
      t.refresh_token_hash.equals(Buffer.from(refreshHash)),
    )!;
    row.refresh_expires_at = new Date(Date.now() - 1000);

    const res = await postToken(
      rig,
      { grant_type: 'refresh_token', refresh_token: old.refresh_token },
      basicAuth(old.client_id, old.client_secret),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error_description: string };
    expect(body.error_description).toMatch(/expired/);
  });
});

describe('POST /oauth/token — misc', () => {
  it('400 unsupported_grant_type for unknown grant_type', async () => {
    const rig = buildRig();
    const { client_id, client_secret } = await register(rig.app);
    const res = await postToken(
      rig,
      { grant_type: 'password' },
      basicAuth(client_id, client_secret),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unsupported_grant_type');
  });

  it('400 invalid_request when body is not form-encoded', async () => {
    const rig = buildRig();
    const { client_id, client_secret } = await register(rig.app);
    const res = await rig.app.request('/oauth/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: basicAuth(client_id, client_secret),
      },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });
});
