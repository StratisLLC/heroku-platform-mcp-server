import { describe, expect, it, vi } from 'vitest';
import { sealSession, WEB_SESSION_TTL_MS, type WebSessionData } from '../../src/auth/session.js';
import { buildRig } from '../helpers/wiring.js';

async function signedInAs(rig: ReturnType<typeof buildRig>, email: string): Promise<string> {
  const user = rig.pool.store.upsertUser({
    heroku_id: 'h-' + email,
    email,
    default_team: null,
  });
  const sealed = sealSession<WebSessionData>(
    { userId: user.id, signedInAt: Date.now() },
    WEB_SESSION_TTL_MS,
    rig.cfg.masterKey,
  );
  return `hmcp_session=${encodeURIComponent(sealed)}`;
}

describe('/me', () => {
  it('renders for a signed-in user', async () => {
    const rig = buildRig();
    const cookie = await signedInAs(rig, 'alice@example.com');
    const res = await rig.app.request('/me', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('alice@example.com');
    // After Phase 4.5 the bearer-token panel is collapsed under <details>;
    // the form still POSTs to /me/sign-out-everywhere with a clearer label.
    expect(body).toContain('Revoke all bearer tokens');
    expect(body).toContain('action="/me/sign-out-everywhere"');
    expect(body).toContain('Connected applications');
  });
});

describe('/me/tokens/:id/revoke', () => {
  it('rejects revoking a token belonging to another user', async () => {
    const rig = buildRig();
    const me = await signedInAs(rig, 'alice@example.com');
    // Insert a token owned by a *different* user.
    const otherUser = rig.pool.store.upsertUser({
      heroku_id: 'h-other',
      email: 'bob@example.com',
      default_team: null,
    });
    const insert = await rig.pool.query<{ id: string }>(
      `INSERT INTO connection_tokens (user_id, token_hash, label)
       VALUES ($1, $2, $3)
       RETURNING id, user_id, token_hash, label, issued_at, last_used_at, revoked_at`,
      [otherUser.id, Buffer.from('hash'), null],
    );
    const otherTokenId = insert.rows[0]!.id;
    const res = await rig.app.request(`/me/tokens/${otherTokenId}/revoke`, {
      method: 'POST',
      headers: { cookie: me },
    });
    expect(res.status).toBe(404);
  });

  it("revokes one of the signed-in user's tokens", async () => {
    const rig = buildRig();
    const me = await signedInAs(rig, 'alice@example.com');
    const userId = rig.pool.store.users[0]!.id;
    const insert = await rig.pool.query<{ id: string }>(
      `INSERT INTO connection_tokens (user_id, token_hash, label)
       VALUES ($1, $2, $3)
       RETURNING id, user_id, token_hash, label, issued_at, last_used_at, revoked_at`,
      [userId, Buffer.from('hash2'), null],
    );
    const tokenId = insert.rows[0]!.id;
    const res = await rig.app.request(`/me/tokens/${tokenId}/revoke`, {
      method: 'POST',
      headers: { cookie: me },
    });
    expect(res.status).toBe(302);
    expect(rig.pool.store.connectionTokens[0]?.revoked_at).toBeInstanceOf(Date);
  });
});

describe('/me/sign-out-everywhere', () => {
  it('revokes every active token and evicts active MCP sessions for the user', async () => {
    const rig = buildRig();
    const me = await signedInAs(rig, 'alice@example.com');
    const userId = rig.pool.store.users[0]!.id;
    await rig.pool.query(
      `INSERT INTO connection_tokens (user_id, token_hash, label)
       VALUES ($1, $2, $3)
       RETURNING id, user_id, token_hash, label, issued_at, last_used_at, revoked_at`,
      [userId, Buffer.from('h1'), null],
    );
    await rig.pool.query(
      `INSERT INTO connection_tokens (user_id, token_hash, label)
       VALUES ($1, $2, $3)
       RETURNING id, user_id, token_hash, label, issued_at, last_used_at, revoked_at`,
      [userId, Buffer.from('h2'), null],
    );
    rig.transports.register(
      {
        userId,
        connectionTokenId: 'tok',
        oauthClientId: null,

        built: { server: { close: vi.fn(async () => undefined) } } as any,

        transport: {} as any,
        clientName: null,
        clientVersion: null,
      },
      'sess',
    );
    expect(rig.transports.size()).toBe(1);
    const res = await rig.app.request('/me/sign-out-everywhere', {
      method: 'POST',
      headers: { cookie: me },
    });
    expect(res.status).toBe(302);
    const active = rig.pool.store.connectionTokens.filter((t) => t.revoked_at === null);
    expect(active.length).toBe(0);
    expect(rig.transports.size()).toBe(0);
  });
});

describe('/audit/export', () => {
  it('returns CSV with the correct content-type and disposition', async () => {
    const rig = buildRig();
    const cookie = await signedInAs(rig, 'alice@example.com');
    const res = await rig.app.request('/audit/export', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/csv/);
    expect(res.headers.get('content-disposition')).toContain('audit-alice@example.com.csv');
  });
});
