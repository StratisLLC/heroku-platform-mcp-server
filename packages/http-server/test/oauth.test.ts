import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  fetchAccount,
  fetchTeams,
  HerokuOAuthError,
  type HerokuOAuthConfig,
} from '../src/oauth/heroku.js';

const cfg: HerokuOAuthConfig = {
  clientId: 'cid',
  clientSecret: 'csec',
  scope: 'write-protected',
  redirectUri: 'https://app/oauth/callback',
  authorizeUrl: 'https://id.heroku.com/oauth/authorize',
  tokenUrl: 'https://id.heroku.com/oauth/token',
  apiBaseUrl: 'https://api.heroku.com',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildAuthorizeUrl', () => {
  it('includes every required OAuth parameter', () => {
    const url = buildAuthorizeUrl(cfg, { state: 'st', codeChallenge: 'cc' });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://id.heroku.com/oauth/authorize');
    expect(u.searchParams.get('client_id')).toBe('cid');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('scope')).toBe('write-protected');
    expect(u.searchParams.get('state')).toBe('st');
    expect(u.searchParams.get('code_challenge')).toBe('cc');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('redirect_uri')).toBe('https://app/oauth/callback');
  });
});

describe('exchangeAuthorizationCode', () => {
  it('POSTs form-encoded body and parses success', async () => {
    const fetchMock = vi.fn(async (url, init) => {
      expect(url).toBe(cfg.tokenUrl);
      expect((init?.headers as Record<string, string>)['Content-Type']).toBe(
        'application/x-www-form-urlencoded',
      );
      const body = String(init?.body);
      expect(body).toContain('grant_type=authorization_code');
      expect(body).toContain('code=AC');
      expect(body).toContain('code_verifier=V');
      expect(body).toContain('client_secret=csec');
      return new Response(
        JSON.stringify({
          access_token: 'AT',
          refresh_token: 'RT',
          expires_in: 28800,
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const res = await exchangeAuthorizationCode(
      { ...cfg, fetch: fetchMock },
      {
        code: 'AC',
        codeVerifier: 'V',
      },
    );
    expect(res).toEqual({
      access_token: 'AT',
      refresh_token: 'RT',
      expires_in: 28800,
      token_type: 'Bearer',
    });
  });

  it('throws HerokuOAuthError with the error_description from the response', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'bad code' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(
      exchangeAuthorizationCode(
        { ...cfg, fetch: fetchMock },
        {
          code: 'X',
          codeVerifier: 'V',
        },
      ),
    ).rejects.toMatchObject({ name: 'HerokuOAuthError', code: 'invalid_grant' });
  });

  it('throws if the response has an unexpected shape', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ partial: 'response' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(
      exchangeAuthorizationCode(
        { ...cfg, fetch: fetchMock },
        {
          code: 'X',
          codeVerifier: 'V',
        },
      ),
    ).rejects.toBeInstanceOf(HerokuOAuthError);
  });
});

describe('fetchAccount', () => {
  it('returns parsed account record', async () => {
    const fetchMock = vi.fn(async (url, init) => {
      expect(url).toBe('https://api.heroku.com/account');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer AT');
      return new Response(
        JSON.stringify({
          id: 'uuid',
          email: 'alice@example.com',
          name: 'Alice',
          default_team: { name: 'eng' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const acct = await fetchAccount({ ...cfg, fetch: fetchMock }, 'AT');
    expect(acct.id).toBe('uuid');
    expect(acct.email).toBe('alice@example.com');
    expect(acct.default_team?.name).toBe('eng');
  });

  it('throws on non-200', async () => {
    const fetchMock = vi.fn(async () => new Response('forbidden', { status: 403 }));
    await expect(fetchAccount({ ...cfg, fetch: fetchMock }, 'AT')).rejects.toBeInstanceOf(
      HerokuOAuthError,
    );
  });
});

describe('fetchTeams', () => {
  it('returns parsed team list', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            { id: 't1', name: 'eng' },
            { id: 't2', name: 'ops' },
          ]),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );
    const teams = await fetchTeams({ ...cfg, fetch: fetchMock }, 'AT');
    expect(teams.map((t) => t.name).sort()).toEqual(['eng', 'ops']);
  });

  it('returns empty array on 403', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 403 }));
    const teams = await fetchTeams({ ...cfg, fetch: fetchMock }, 'AT');
    expect(teams).toEqual([]);
  });

  it('returns empty array on 404', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 404 }));
    const teams = await fetchTeams({ ...cfg, fetch: fetchMock }, 'AT');
    expect(teams).toEqual([]);
  });
});
