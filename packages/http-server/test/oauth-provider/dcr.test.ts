/**
 * Tests for the Dynamic Client Registration endpoint (RFC 7591).
 *
 *   POST /oauth/register
 */

import { describe, expect, it } from 'vitest';
import { buildRig } from '../helpers/wiring.js';
import {
  generateClientId,
  generateClientSecret,
  sha256Bytes,
} from '../../src/oauth-provider/dcr.js';

async function register(
  app: import('hono').Hono<import('../../src/auth/middleware.js').AppEnv>,
  body: unknown,
): Promise<Response> {
  return app.request('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /oauth/register', () => {
  it('happy path: mints client_id + client_secret and persists the row', async () => {
    const rig = buildRig();
    const res = await register(rig.app, {
      client_name: 'Claude Desktop',
      redirect_uris: ['https://claude.ai/oauth-callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_basic',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      client_id: string;
      client_secret: string;
      client_secret_expires_at: number;
      client_id_issued_at: number;
      client_name: string;
      redirect_uris: string[];
      registration_client_uri: string;
    };
    expect(body.client_id).toMatch(/^[0-9a-f]{32}$/);
    expect(body.client_secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.client_secret_expires_at).toBe(0);
    expect(body.client_id_issued_at).toBeGreaterThan(0);
    expect(body.client_name).toBe('Claude Desktop');
    expect(body.redirect_uris).toEqual(['https://claude.ai/oauth-callback']);
    expect(body.registration_client_uri).toBe(
      `https://test.example.com/oauth/register/${body.client_id}`,
    );

    // Persisted under the SHA-256 of client_secret.
    const stored = rig.pool.store.oauthClients[0];
    expect(stored?.client_id).toBe(body.client_id);
    expect(
      Buffer.from(stored!.client_secret_hash).equals(Buffer.from(sha256Bytes(body.client_secret))),
    ).toBe(true);
  });

  it('defaults grant_types and token_endpoint_auth_method when omitted', async () => {
    const rig = buildRig();
    const res = await register(rig.app, {
      redirect_uris: ['https://example/cb'],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      grant_types: string[];
      token_endpoint_auth_method: string;
    };
    expect(body.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(body.token_endpoint_auth_method).toBe('client_secret_basic');
  });

  it('rejects missing redirect_uris', async () => {
    const rig = buildRig();
    const res = await register(rig.app, { client_name: 'X' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_client_metadata');
  });

  it('rejects an empty redirect_uris array', async () => {
    const rig = buildRig();
    const res = await register(rig.app, { redirect_uris: [] });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed redirect_uri', async () => {
    const rig = buildRig();
    const res = await register(rig.app, { redirect_uris: ['not-a-url'] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_redirect_uri');
  });

  it('rejects unsupported grant_types', async () => {
    const rig = buildRig();
    const res = await register(rig.app, {
      redirect_uris: ['https://x/cb'],
      grant_types: ['password'],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe('invalid_client_metadata');
    expect(body.error_description).toMatch(/grant_type/);
  });

  it('rejects unsupported response_types', async () => {
    const rig = buildRig();
    const res = await register(rig.app, {
      redirect_uris: ['https://x/cb'],
      response_types: ['token'],
    });
    expect(res.status).toBe(400);
  });

  it('rejects an unsupported token_endpoint_auth_method', async () => {
    const rig = buildRig();
    const res = await register(rig.app, {
      redirect_uris: ['https://x/cb'],
      token_endpoint_auth_method: 'private_key_jwt',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe('invalid_client_metadata');
    expect(body.error_description).toMatch(/token_endpoint_auth_method/);
  });

  it('registers a PUBLIC client (auth method "none"): no secret, echoes "none"', async () => {
    const rig = buildRig();
    const res = await register(rig.app, {
      client_name: 'Cursor',
      redirect_uris: ['https://cursor.example/cb'],
      token_endpoint_auth_method: 'none',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.client_id).toMatch(/^[0-9a-f]{32}$/);
    expect(body.token_endpoint_auth_method).toBe('none');
    // RFC 7591: a public client's response carries NO secret.
    expect('client_secret' in body).toBe(false);
    expect('client_secret_expires_at' in body).toBe(false);

    // Stored as a public client; the NOT NULL secret-hash column still holds a
    // value, but it is a non-disclosed sentinel (not derivable by any caller).
    const stored = rig.pool.store.oauthClients.find((x) => x.client_id === body.client_id);
    expect(stored?.token_endpoint_auth_method).toBe('none');
    expect(stored?.client_secret_hash?.length).toBeGreaterThan(0);
  });

  it('rejects a non-JSON body', async () => {
    const rig = buildRig();
    const res = await rig.app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('accepts http(s) and custom-scheme redirect URIs', async () => {
    const rig = buildRig();
    const ok = await register(rig.app, {
      redirect_uris: ['https://x/cb', 'http://localhost:1234/cb', 'claude-desktop://oauth'],
    });
    expect(ok.status).toBe(201);
  });
});

describe('id/secret generators', () => {
  it('generateClientId is 32 hex chars', () => {
    expect(generateClientId()).toMatch(/^[0-9a-f]{32}$/);
  });
  it('generateClientSecret is 43 base64url chars', () => {
    expect(generateClientSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it('every call returns distinct values', () => {
    expect(generateClientId()).not.toBe(generateClientId());
    expect(generateClientSecret()).not.toBe(generateClientSecret());
  });
});
