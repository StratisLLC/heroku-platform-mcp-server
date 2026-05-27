/**
 * /me page Connected Applications section + revoke endpoint.
 */

import { describe, expect, it } from 'vitest';
import { buildRig } from '../helpers/wiring.js';
import {
  sealSession,
  WEB_SESSION_COOKIE,
  WEB_SESSION_TTL_MS,
  type WebSessionData,
} from '../../src/auth/session.js';
import { insertOAuthClient, bindClientToUser } from '../../src/db/repos/oauth-clients.js';
import { insertOAuthToken } from '../../src/db/repos/oauth-tokens.js';
import { sha256Bytes } from '../../src/oauth-provider/token.js';

function seedSession(rig: ReturnType<typeof buildRig>, email = 'u@example.com'): {
  cookie: string;
  userId: string;
} {
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
  return {
    cookie: `${WEB_SESSION_COOKIE}=${encodeURIComponent(sealed)}`,
    userId: user.id,
  };
}

describe('/me page — Connected Applications', () => {
  it('renders "No connected applications" when the user has none', async () => {
    const rig = buildRig();
    const { cookie } = seedSession(rig);
    const res = await rig.app.request('/me', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Connected applications');
    expect(body).toContain('No connected applications yet');
    // Bearer section is rendered (collapsed under details).
    expect(body).toContain('Advanced: bearer token');
  });

  it('lists OAuth clients bound to the user with a Revoke button', async () => {
    const rig = buildRig();
    const { cookie, userId } = seedSession(rig);
    await insertOAuthClient(rig.pool as never, {
      clientId: 'client-abc',
      clientSecretHash: sha256Bytes('s'),
      clientName: 'Claude Desktop',
      redirectUris: ['https://claude.ai/cb'],
    });
    await bindClientToUser(rig.pool as never, 'client-abc', userId);

    const res = await rig.app.request('/me', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Claude Desktop');
    expect(body).toContain('/me/clients/client-abc/revoke');
  });

  it('shows the Custom Connector URL pointing at the server', async () => {
    const rig = buildRig();
    const { cookie } = seedSession(rig);
    const res = await rig.app.request('/me', { headers: { cookie } });
    const body = await res.text();
    expect(body).toContain('https://test.example.com/mcp');
  });
});

describe('POST /me/clients/:id/revoke', () => {
  it('revokes the client and its OAuth tokens; redirects back to /me', async () => {
    const rig = buildRig();
    const { cookie, userId } = seedSession(rig);
    await insertOAuthClient(rig.pool as never, {
      clientId: 'client-xyz',
      clientSecretHash: sha256Bytes('s'),
      clientName: 'Claude Desktop',
      redirectUris: ['https://claude.ai/cb'],
    });
    await bindClientToUser(rig.pool as never, 'client-xyz', userId);
    await insertOAuthToken(rig.pool as never, {
      accessTokenHash: sha256Bytes('a'),
      refreshTokenHash: sha256Bytes('r'),
      clientId: 'client-xyz',
      userId,
      expiresAt: new Date(Date.now() + 60_000),
      refreshExpiresAt: new Date(Date.now() + 60_000),
    });

    const res = await rig.app.request('/me/clients/client-xyz/revoke', {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/me');

    // Client and its tokens are revoked.
    expect(rig.pool.store.oauthClients[0]?.revoked_at).toBeInstanceOf(Date);
    expect(rig.pool.store.oauthTokens[0]?.revoked_at).toBeInstanceOf(Date);
  });

  it('404 when the client does not belong to the signed-in user', async () => {
    const rig = buildRig();
    const { cookie } = seedSession(rig);
    // Create a client bound to a DIFFERENT user.
    const otherUser = rig.pool.store.upsertUser({
      heroku_id: 'h2',
      email: 'other@example.com',
      default_team: null,
    });
    await insertOAuthClient(rig.pool as never, {
      clientId: 'their-client',
      clientSecretHash: sha256Bytes('s'),
      redirectUris: ['https://x/cb'],
    });
    await bindClientToUser(rig.pool as never, 'their-client', otherUser.id);

    const res = await rig.app.request('/me/clients/their-client/revoke', {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });

  it('redirects unauthenticated requests to /sign-in', async () => {
    const rig = buildRig();
    const res = await rig.app.request('/me/clients/anything/revoke', {
      method: 'POST',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/sign-in');
  });
});
