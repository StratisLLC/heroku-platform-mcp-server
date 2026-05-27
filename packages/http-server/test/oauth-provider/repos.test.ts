/**
 * Repository-level tests for the three OAuth provider tables. Uses the
 * FakePool — the real-Postgres equivalents are exercised by the integration
 * test.
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createFakePool } from '../helpers/fake-pool.js';
import {
  insertOAuthClient,
  findOAuthClientById,
  bindClientToUser,
  touchClientLastUsed,
  revokeOAuthClient,
  listClientsForUser,
} from '../../src/db/repos/oauth-clients.js';
import {
  insertOAuthAuthorization,
  findAuthorizationByCodeHash,
  markAuthorizationUsed,
} from '../../src/db/repos/oauth-authorizations.js';
import {
  insertOAuthToken,
  findActiveOAuthTokenByAccessHash,
  findOAuthTokenByRefreshHash,
  findOAuthTokenByAccessHash,
  revokeOAuthTokenByAccessHash,
  revokeOAuthTokenByRefreshHash,
  revokeAllTokensForClient,
  listActiveTokensForUserClient,
} from '../../src/db/repos/oauth-tokens.js';
import type pg from 'pg';

function sha(s: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(s).digest());
}

function fakePool() {
  return createFakePool() as unknown as pg.Pool;
}

describe('oauth_clients repo', () => {
  it('insert + find round-trips all stored fields', async () => {
    const pool = fakePool();
    const out = await insertOAuthClient(pool, {
      clientId: 'abc123',
      clientSecretHash: sha('secret'),
      clientName: 'Claude Desktop',
      redirectUris: ['https://claude.ai/oauth-callback'],
    });
    expect(out.clientId).toBe('abc123');
    expect(out.clientName).toBe('Claude Desktop');
    expect(out.redirectUris).toEqual(['https://claude.ai/oauth-callback']);
    expect(out.grantTypes).toEqual(['authorization_code', 'refresh_token']);
    expect(out.tokenEndpointAuthMethod).toBe('client_secret_basic');
    expect(out.userId).toBeNull();
    expect(out.revokedAt).toBeNull();

    const found = await findOAuthClientById(pool, 'abc123');
    expect(found?.clientName).toBe('Claude Desktop');
  });

  it('findOAuthClientById returns null for unknown client', async () => {
    const pool = fakePool();
    expect(await findOAuthClientById(pool, 'nope')).toBeNull();
  });

  it('bindClientToUser sets the user_id and last_used_at', async () => {
    const pool = fakePool();
    await insertOAuthClient(pool, {
      clientId: 'c1',
      clientSecretHash: sha('s'),
      redirectUris: ['https://x'],
    });
    await bindClientToUser(pool, 'c1', 'user-1');
    const c = await findOAuthClientById(pool, 'c1');
    expect(c?.userId).toBe('user-1');
    expect(c?.lastUsedAt).toBeInstanceOf(Date);
  });

  it('touchClientLastUsed updates last_used_at', async () => {
    const pool = fakePool();
    await insertOAuthClient(pool, {
      clientId: 'c2',
      clientSecretHash: sha('s'),
      redirectUris: ['https://x'],
    });
    await touchClientLastUsed(pool, 'c2');
    const c = await findOAuthClientById(pool, 'c2');
    expect(c?.lastUsedAt).toBeInstanceOf(Date);
  });

  it('revokeOAuthClient sets revoked_at', async () => {
    const pool = fakePool();
    await insertOAuthClient(pool, {
      clientId: 'c3',
      clientSecretHash: sha('s'),
      redirectUris: ['https://x'],
    });
    await revokeOAuthClient(pool, 'c3');
    const c = await findOAuthClientById(pool, 'c3');
    expect(c?.revokedAt).toBeInstanceOf(Date);
  });

  it('listClientsForUser filters by user_id and respects includeRevoked', async () => {
    const pool = fakePool();
    await insertOAuthClient(pool, {
      clientId: 'a',
      clientSecretHash: sha('s'),
      redirectUris: ['x'],
    });
    await insertOAuthClient(pool, {
      clientId: 'b',
      clientSecretHash: sha('s'),
      redirectUris: ['x'],
    });
    await bindClientToUser(pool, 'a', 'user-1');
    await bindClientToUser(pool, 'b', 'user-1');
    await revokeOAuthClient(pool, 'b');

    const active = await listClientsForUser(pool, 'user-1');
    expect(active.map((c) => c.clientId)).toEqual(['a']);

    const all = await listClientsForUser(pool, 'user-1', { includeRevoked: true });
    expect(all.map((c) => c.clientId).sort()).toEqual(['a', 'b']);
  });
});

describe('oauth_authorizations repo', () => {
  async function setup() {
    const pool = fakePool();
    pool.store!.users.push({
      id: 'user-1',
      heroku_id: 'h1',
      email: 'u@example.com',
      default_team: null,
      signed_in_at: new Date(),
      last_seen_at: new Date(),
    });
    await insertOAuthClient(pool, {
      clientId: 'c1',
      clientSecretHash: sha('s'),
      redirectUris: ['https://x/cb'],
    });
    return pool;
  }

  it('insert + find round-trip', async () => {
    const pool = await setup();
    const codeHash = sha('the-code');
    await insertOAuthAuthorization(pool, {
      codeHash,
      clientId: 'c1',
      userId: 'user-1',
      redirectUri: 'https://x/cb',
      codeChallenge: 'CHALLENGE',
      expiresAt: new Date(Date.now() + 60_000),
      state: 'abc',
      scope: null,
    });
    const found = await findAuthorizationByCodeHash(pool, codeHash);
    expect(found?.clientId).toBe('c1');
    expect(found?.userId).toBe('user-1');
    expect(found?.codeChallenge).toBe('CHALLENGE');
    expect(found?.state).toBe('abc');
    expect(found?.usedAt).toBeNull();
  });

  it('markAuthorizationUsed succeeds once, then returns false on replay', async () => {
    const pool = await setup();
    const codeHash = sha('code-2');
    await insertOAuthAuthorization(pool, {
      codeHash,
      clientId: 'c1',
      userId: 'user-1',
      redirectUri: 'https://x/cb',
      codeChallenge: 'C',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const first = await markAuthorizationUsed(pool, codeHash);
    expect(first).toBe(true);
    const second = await markAuthorizationUsed(pool, codeHash);
    expect(second).toBe(false);
    const found = await findAuthorizationByCodeHash(pool, codeHash);
    expect(found?.usedAt).toBeInstanceOf(Date);
  });

  it('find returns null for unknown code', async () => {
    const pool = await setup();
    expect(await findAuthorizationByCodeHash(pool, sha('nope'))).toBeNull();
  });
});

describe('oauth_tokens repo', () => {
  async function setup() {
    const pool = fakePool();
    pool.store!.users.push({
      id: 'user-1',
      heroku_id: 'h1',
      email: 'u@example.com',
      default_team: null,
      signed_in_at: new Date(),
      last_seen_at: new Date(),
    });
    await insertOAuthClient(pool, {
      clientId: 'c1',
      clientSecretHash: sha('s'),
      redirectUris: ['https://x/cb'],
    });
    return pool;
  }

  async function mkToken(pool: pg.Pool, opts: { ttlMs?: number; rTtlMs?: number } = {}) {
    const accessHash = sha('access-' + Math.random());
    const refreshHash = sha('refresh-' + Math.random());
    const ttlMs = opts.ttlMs ?? 3600_000;
    const rTtlMs = opts.rTtlMs ?? 90 * 24 * 3600 * 1000;
    await insertOAuthToken(pool, {
      accessTokenHash: accessHash,
      refreshTokenHash: refreshHash,
      clientId: 'c1',
      userId: 'user-1',
      expiresAt: new Date(Date.now() + ttlMs),
      refreshExpiresAt: new Date(Date.now() + rTtlMs),
    });
    return { accessHash, refreshHash };
  }

  it('insert + find by access hash returns active token', async () => {
    const pool = await setup();
    const { accessHash } = await mkToken(pool);
    const t = await findActiveOAuthTokenByAccessHash(pool, accessHash);
    expect(t?.clientId).toBe('c1');
    expect(t?.userId).toBe('user-1');
  });

  it('expired token is not returned by findActiveOAuthTokenByAccessHash', async () => {
    const pool = await setup();
    const { accessHash } = await mkToken(pool, { ttlMs: -1000 });
    expect(await findActiveOAuthTokenByAccessHash(pool, accessHash)).toBeNull();
  });

  it('revoked token is not returned by findActive*', async () => {
    const pool = await setup();
    const { accessHash } = await mkToken(pool);
    await revokeOAuthTokenByAccessHash(pool, accessHash);
    expect(await findActiveOAuthTokenByAccessHash(pool, accessHash)).toBeNull();
  });

  it('findOAuthTokenByAccessHash returns revoked tokens (for revoke endpoint)', async () => {
    const pool = await setup();
    const { accessHash } = await mkToken(pool);
    await revokeOAuthTokenByAccessHash(pool, accessHash);
    const t = await findOAuthTokenByAccessHash(pool, accessHash);
    expect(t?.revokedAt).toBeInstanceOf(Date);
  });

  it('findOAuthTokenByRefreshHash returns rows regardless of state', async () => {
    const pool = await setup();
    const { refreshHash } = await mkToken(pool);
    const t = await findOAuthTokenByRefreshHash(pool, refreshHash);
    expect(t).not.toBeNull();
  });

  it('revokeOAuthTokenByRefreshHash marks the row revoked', async () => {
    const pool = await setup();
    const { accessHash, refreshHash } = await mkToken(pool);
    await revokeOAuthTokenByRefreshHash(pool, refreshHash);
    expect(await findActiveOAuthTokenByAccessHash(pool, accessHash)).toBeNull();
  });

  it('revokeAllTokensForClient revokes every active token for that client', async () => {
    const pool = await setup();
    await mkToken(pool);
    await mkToken(pool);
    const n = await revokeAllTokensForClient(pool, 'c1');
    expect(n).toBe(2);
    const second = await revokeAllTokensForClient(pool, 'c1');
    expect(second).toBe(0);
  });

  it('listActiveTokensForUserClient returns only non-revoked tokens for the pair', async () => {
    const pool = await setup();
    const a = await mkToken(pool);
    const b = await mkToken(pool);
    await revokeOAuthTokenByAccessHash(pool, b.accessHash);
    const active = await listActiveTokensForUserClient(pool, 'user-1', 'c1');
    expect(active.length).toBe(1);
    expect(Buffer.from(active[0]!.accessTokenHash).equals(Buffer.from(a.accessHash))).toBe(true);
  });
});
