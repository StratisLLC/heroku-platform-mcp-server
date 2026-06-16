/**
 * End-to-end OAuth flow tests: sign-in → callback → /me. Uses the fake pool
 * and a mocked Heroku fetch.
 */

import { describe, expect, it, vi } from 'vitest';
import { buildRig } from '../helpers/wiring.js';

function mockHerokuFetch(opts: {
  account: { id: string; email: string; default_team?: { name: string } | null };
  teams?: { id: string; name: string }[];
  tokenStatus?: number;
}): typeof globalThis.fetch {
  return vi.fn(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === 'https://id.heroku.com/oauth/token') {
      const status = opts.tokenStatus ?? 200;
      if (status >= 400) {
        return new Response(
          JSON.stringify({ error: 'invalid_grant', error_description: 'bad code' }),
          { status, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          access_token: 'AT-' + Math.random().toString(36).slice(2),
          refresh_token: 'RT-' + Math.random().toString(36).slice(2),
          expires_in: 28800,
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url === 'https://api.heroku.com/account') {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toMatch(/^Bearer /);
      return new Response(JSON.stringify(opts.account), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === 'https://api.heroku.com/teams') {
      return new Response(JSON.stringify(opts.teams ?? []), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

async function startSignIn(
  app: import('hono').Hono<import('../../src/auth/middleware.js').AppEnv>,
): Promise<{
  flowCookie: string;
  state: string;
}> {
  const res = await app.request('/sign-in');
  expect(res.status).toBe(302);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const m = /hmcp_oauth_flow=([^;]+)/.exec(setCookie);
  const flowCookie = decodeURIComponent(m?.[1] ?? '');
  const stateMatch = /state=([^&]+)/.exec(res.headers.get('location') ?? '');
  return { flowCookie, state: decodeURIComponent(stateMatch?.[1] ?? '') };
}

describe('OAuth callback flow', () => {
  it('happy path: completes sign-in, sets session cookie, and shows the token on /me', async () => {
    const rig = buildRig({
      herokuFetch: mockHerokuFetch({
        account: { id: 'heroku-1', email: 'alice@example.com', default_team: { name: 'eng' } },
        teams: [{ id: 't1', name: 'eng' }],
      }),
    });
    const { flowCookie, state } = await startSignIn(rig.app);

    const callback = await rig.app.request(
      `/oauth/callback?code=AC&state=${encodeURIComponent(state)}`,
      {
        headers: { cookie: `hmcp_oauth_flow=${encodeURIComponent(flowCookie)}` },
      },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/me');
    // Session cookie is set.
    const setCookie = callback.headers.get('set-cookie') ?? '';
    const sessionMatch = /hmcp_session=([^;]+)/.exec(setCookie);
    const sealedSession = decodeURIComponent(sessionMatch?.[1] ?? '');
    expect(sealedSession.length).toBeGreaterThan(0);

    // Visit /me; the first paint should include the freshly-minted token.
    const me = await rig.app.request('/me', {
      headers: { cookie: `hmcp_session=${encodeURIComponent(sealedSession)}` },
    });
    expect(me.status).toBe(200);
    const body = await me.text();
    expect(body).toMatch(/hmcp_/);
    expect(body).toContain('alice@example.com');
    expect(body).toContain('Claude Desktop config snippet');

    // The DB now contains user + tokens + connection-token.
    expect(rig.pool.store.users[0]?.email).toBe('alice@example.com');
    expect(rig.pool.store.herokuTokens.length).toBe(1);
    expect(rig.pool.store.connectionTokens.length).toBe(1);
    expect(rig.pool.store.auditLog.some((a) => a.event_name === 'sign_in')).toBe(true);
    expect(rig.pool.store.auditLog.some((a) => a.event_name === 'token_issued')).toBe(true);
  });

  it('state mismatch is treated as a 400 sign-in failure', async () => {
    const rig = buildRig({
      herokuFetch: mockHerokuFetch({
        account: { id: 'heroku-1', email: 'alice@example.com' },
      }),
    });
    const { flowCookie } = await startSignIn(rig.app);
    const res = await rig.app.request(`/oauth/callback?code=AC&state=BAD`, {
      headers: { cookie: `hmcp_oauth_flow=${encodeURIComponent(flowCookie)}` },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/state mismatch/i);
  });

  it('access denied: not on email allowlist renders the denial page and writes an audit row', async () => {
    const rig = buildRig({
      allowedEmails: ['only-this@example.com'],
      herokuFetch: mockHerokuFetch({
        account: { id: 'heroku-1', email: 'evil@example.com' },
      }),
    });
    const { flowCookie, state } = await startSignIn(rig.app);
    const res = await rig.app.request(
      `/oauth/callback?code=AC&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `hmcp_oauth_flow=${encodeURIComponent(flowCookie)}` } },
    );
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain('Access denied');
    expect(body).toContain('o***@example.com'); // masked allowlist
    expect(body).toContain('admin@example.com'); // admin contact
    expect(rig.pool.store.auditLog.some((a) => a.event_name === 'access_denied')).toBe(true);
  });

  it('token exchange failure renders a 400 with the error message', async () => {
    const rig = buildRig({
      herokuFetch: mockHerokuFetch({
        account: { id: 'heroku-1', email: 'alice@example.com' },
        tokenStatus: 400,
      }),
    });
    const { flowCookie, state } = await startSignIn(rig.app);
    const res = await rig.app.request(
      `/oauth/callback?code=AC&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `hmcp_oauth_flow=${encodeURIComponent(flowCookie)}` } },
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/Sign-in failed|bad code/);
  });
});
