/**
 * resolveUserAccessToken — proactive token refresh and ReauthRequiredError
 * behavior. (The completeSignIn happy path is covered by the OAuth e2e
 * integration test; here we only exercise the read-side refresh logic.)
 */

import { describe, expect, it, vi } from 'vitest';
import {
  decodeFromStorage,
  decryptWithDek,
  decryptWithKek,
  encodeForStorage,
  encryptWithDek,
  encryptWithKek,
  generateDek,
  generateMasterKey,
} from '@heroku-mcp/core';
import { ReauthRequiredError, resolveUserAccessToken } from '../src/oauth/flow.js';
import type { HerokuOAuthConfig } from '../src/oauth/heroku.js';
import { createFakePool, type FakePool } from './helpers/fake-pool.js';

const USER_ID = '00000000-0000-0000-0000-000000000001';

function makeOauthCfg(fetchFn: typeof globalThis.fetch): HerokuOAuthConfig {
  return {
    clientId: 'cid',
    clientSecret: 'csec',
    scope: 'write-protected',
    redirectUri: 'https://app/oauth/callback',
    authorizeUrl: 'https://id.heroku.com/oauth/authorize',
    tokenUrl: 'https://id.heroku.com/oauth/token',
    apiBaseUrl: 'https://api.heroku.com',
    fetch: fetchFn,
  };
}

function seedTokenRow(
  pool: FakePool,
  masterKey: Uint8Array,
  opts: { accessToken: string; refreshToken: string; expiresAt: Date },
): void {
  const dek = generateDek();
  const accessBlob = encodeForStorage(
    encryptWithDek(new TextEncoder().encode(opts.accessToken), dek),
  );
  const refreshBlob = encodeForStorage(
    encryptWithDek(new TextEncoder().encode(opts.refreshToken), dek),
  );
  const dekBlob = encodeForStorage(encryptWithKek(dek, masterKey));
  pool.store.herokuTokens.push({
    user_id: USER_ID,
    encrypted_access_token: Buffer.from(accessBlob),
    encrypted_refresh_token: Buffer.from(refreshBlob),
    encrypted_dek: Buffer.from(dekBlob),
    expires_at: opts.expiresAt,
    refreshed_at: new Date(0),
  });
}

describe('resolveUserAccessToken', () => {
  it('returns the existing token when it is comfortably in-date and does not refresh', async () => {
    const masterKey = generateMasterKey();
    const pool = createFakePool();
    seedTokenRow(pool, masterKey, {
      accessToken: 'AT-current',
      refreshToken: 'RT-current',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1h ahead
    });
    const fetchMock = vi.fn(async () => new Response('should not be called', { status: 500 }));
    const out = await resolveUserAccessToken(
      pool as unknown as import('pg').Pool,
      USER_ID,
      masterKey,
      makeOauthCfg(fetchMock),
    );
    expect(out).toBe('AT-current');
    expect(fetchMock).not.toHaveBeenCalled();
    // Row was not rewritten.
    const row = pool.store.herokuTokens[0]!;
    expect(row.refreshed_at.valueOf()).toBe(0);
  });

  it('refreshes when expires_at is in the past and persists the new tokens', async () => {
    const masterKey = generateMasterKey();
    const pool = createFakePool();
    seedTokenRow(pool, masterKey, {
      accessToken: 'AT-stale',
      refreshToken: 'RT-stale',
      expiresAt: new Date(Date.now() - 60 * 1000), // expired 1 minute ago
    });

    const fetchMock = vi.fn(async (url, init) => {
      expect(url).toBe('https://id.heroku.com/oauth/token');
      const body = String(init?.body);
      expect(body).toContain('grant_type=refresh_token');
      expect(body).toContain('refresh_token=RT-stale');
      expect(body).toContain('client_secret=csec');
      return new Response(
        JSON.stringify({
          access_token: 'AT-fresh',
          refresh_token: 'RT-rotated',
          expires_in: 28800,
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const out = await resolveUserAccessToken(
      pool as unknown as import('pg').Pool,
      USER_ID,
      masterKey,
      makeOauthCfg(fetchMock as unknown as typeof globalThis.fetch),
    );
    expect(out).toBe('AT-fresh');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Row was rewritten with the new tokens (verify by decrypting).
    const row = pool.store.herokuTokens[0]!;
    const dek = decryptWithKek(decodeFromStorage(new Uint8Array(row.encrypted_dek)), masterKey);
    const access = new TextDecoder().decode(
      decryptWithDek(decodeFromStorage(new Uint8Array(row.encrypted_access_token)), dek),
    );
    const refresh = new TextDecoder().decode(
      decryptWithDek(decodeFromStorage(new Uint8Array(row.encrypted_refresh_token)), dek),
    );
    expect(access).toBe('AT-fresh');
    expect(refresh).toBe('RT-rotated');
    // expires_at is now ~ now+8h.
    expect(row.expires_at.valueOf()).toBeGreaterThan(Date.now() + 28000 * 1000);
  });

  it('refreshes when expires_at is within the 60s expiry buffer', async () => {
    const masterKey = generateMasterKey();
    const pool = createFakePool();
    seedTokenRow(pool, masterKey, {
      accessToken: 'AT-near-expiry',
      refreshToken: 'RT-near-expiry',
      expiresAt: new Date(Date.now() + 30 * 1000), // 30s ahead — inside buffer
    });

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          access_token: 'AT-fresh',
          refresh_token: 'RT-fresh',
          expires_in: 28800,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const out = await resolveUserAccessToken(
      pool as unknown as import('pg').Pool,
      USER_ID,
      masterKey,
      makeOauthCfg(fetchMock),
    );
    expect(out).toBe('AT-fresh');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('persists the rotated refresh_token Heroku returns alongside the new access token', async () => {
    const masterKey = generateMasterKey();
    const pool = createFakePool();
    seedTokenRow(pool, masterKey, {
      accessToken: 'AT-old',
      refreshToken: 'RT-old',
      expiresAt: new Date(Date.now() - 1000),
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'AT-new',
            refresh_token: 'RT-DIFFERENT-FROM-OLD',
            expires_in: 28800,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    await resolveUserAccessToken(
      pool as unknown as import('pg').Pool,
      USER_ID,
      masterKey,
      makeOauthCfg(fetchMock),
    );

    const row = pool.store.herokuTokens[0]!;
    const dek = decryptWithKek(decodeFromStorage(new Uint8Array(row.encrypted_dek)), masterKey);
    const refresh = new TextDecoder().decode(
      decryptWithDek(decodeFromStorage(new Uint8Array(row.encrypted_refresh_token)), dek),
    );
    expect(refresh).toBe('RT-DIFFERENT-FROM-OLD');
  });

  it('throws ReauthRequiredError when Heroku rejects the refresh token with 4xx', async () => {
    const masterKey = generateMasterKey();
    const pool = createFakePool();
    seedTokenRow(pool, masterKey, {
      accessToken: 'AT-revoked',
      refreshToken: 'RT-revoked',
      expiresAt: new Date(Date.now() - 1000),
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: 'invalid_grant', error_description: 'authorization revoked' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    );

    await expect(
      resolveUserAccessToken(
        pool as unknown as import('pg').Pool,
        USER_ID,
        masterKey,
        makeOauthCfg(fetchMock),
      ),
    ).rejects.toBeInstanceOf(ReauthRequiredError);

    // Stored tokens must remain untouched on refresh failure — the user might
    // recover by re-authenticating, and we should not overwrite their row.
    const row = pool.store.herokuTokens[0]!;
    expect(row.refreshed_at.valueOf()).toBe(0);
  });

  it('rethrows transient 5xx refresh failures unchanged (caller retries / next request tries again)', async () => {
    const masterKey = generateMasterKey();
    const pool = createFakePool();
    seedTokenRow(pool, masterKey, {
      accessToken: 'AT-old',
      refreshToken: 'RT-old',
      expiresAt: new Date(Date.now() - 1000),
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'server_error' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(
      resolveUserAccessToken(
        pool as unknown as import('pg').Pool,
        USER_ID,
        masterKey,
        makeOauthCfg(fetchMock),
      ),
    ).rejects.not.toBeInstanceOf(ReauthRequiredError);
  });

  it('throws when no token row exists', async () => {
    const masterKey = generateMasterKey();
    const pool = createFakePool();
    const fetchMock = vi.fn(async () => new Response('', { status: 500 }));
    await expect(
      resolveUserAccessToken(
        pool as unknown as import('pg').Pool,
        USER_ID,
        masterKey,
        makeOauthCfg(fetchMock),
      ),
    ).rejects.toThrow(/No stored Heroku tokens/);
  });
});
