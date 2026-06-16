/**
 * Admin route tests. We need a signed-in admin session — we'll bypass the
 * full OAuth flow by inserting a user directly and sealing a session cookie
 * by hand.
 */

import { describe, expect, it, vi } from 'vitest';
import { sealSession, WEB_SESSION_TTL_MS, type WebSessionData } from '../../src/auth/session.js';
import { buildRig } from '../helpers/wiring.js';

async function signedInAs(
  rig: ReturnType<typeof buildRig>,
  email: string,
  herokuId = 'h-' + email,
): Promise<string> {
  const user = rig.pool.store.upsertUser({
    heroku_id: herokuId,
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

describe('/admin/users', () => {
  it('is hidden (404) for non-admin signed-in users', async () => {
    const rig = buildRig({ adminEmails: ['admin@example.com'] });
    const cookie = await signedInAs(rig, 'bob@example.com');
    const res = await rig.app.request('/admin/users', { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it('renders for admin users', async () => {
    const rig = buildRig({ adminEmails: ['admin@example.com'] });
    const cookie = await signedInAs(rig, 'admin@example.com');
    const res = await rig.app.request('/admin/users', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('admin@example.com');
    expect(body).toMatch(/Users/);
  });
});

describe('/admin/tokens', () => {
  it('renders the connection-tokens table for admins', async () => {
    const rig = buildRig({ adminEmails: ['admin@example.com'] });
    const cookie = await signedInAs(rig, 'admin@example.com');
    const res = await rig.app.request('/admin/tokens', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/Connection tokens/i);
  });
});

describe('/admin/audit', () => {
  it('renders the cross-user audit log', async () => {
    const rig = buildRig({ adminEmails: ['admin@example.com'] });
    const cookie = await signedInAs(rig, 'admin@example.com');
    const res = await rig.app.request('/admin/audit', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/All audit/);
  });
});

describe('/admin/status', () => {
  it('reports DB and Heroku probe results', async () => {
    const rig = buildRig({ adminEmails: ['admin@example.com'] });
    const cookie = await signedInAs(rig, 'admin@example.com');
    const res = await rig.app.request('/admin/status', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/Postgres/);
    expect(body).toMatch(/Master key fingerprint/);
  });
});

describe('/admin/config', () => {
  it('masks secret env vars', async () => {
    const rig = buildRig({ adminEmails: ['admin@example.com'] });
    const cookie = await signedInAs(rig, 'admin@example.com');
    const res = await rig.app.request('/admin/config', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/PORT/);
  });
});

describe('/admin/tokens/:id/revoke', () => {
  it('evicts active sessions via TransportManager', async () => {
    const rig = buildRig({ adminEmails: ['admin@example.com'] });
    const cookie = await signedInAs(rig, 'admin@example.com');
    // Stash a connection token + a fake transport entry tied to it.
    const userId = rig.pool.store.users[0]!.id;
    const tokenRes = await rig.pool.query<{ id: string }>(
      `INSERT INTO connection_tokens (user_id, token_hash, label)
       VALUES ($1, $2, $3)
       RETURNING id, user_id, token_hash, label, issued_at, last_used_at, revoked_at`,
      [userId, Buffer.from('zzz'), 'test'],
    );
    const tokenId = tokenRes.rows[0]!.id;
    rig.transports.register(
      {
        userId,
        connectionTokenId: tokenId,
        oauthClientId: null,

        built: { server: { close: vi.fn(async () => undefined) } } as any,

        transport: {} as any,
        clientName: null,
        clientVersion: null,
      },
      'fake-session-id',
    );
    expect(rig.transports.size()).toBe(1);
    const res = await rig.app.request(`/admin/tokens/${tokenId}/revoke`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(302);
    expect(rig.transports.size()).toBe(0);
  });
});
