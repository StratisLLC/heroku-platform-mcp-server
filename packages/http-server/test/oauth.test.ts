import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  fetchAccount,
  fetchTeams,
  HerokuOAuthError,
  HerokuTokenResponse,
  normalizeScope,
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

  it('normalises a global scope on the authorize URL', () => {
    const url = buildAuthorizeUrl(
      { ...cfg, scope: 'identity,global' },
      { state: 'st', codeChallenge: 'cc' },
    );
    expect(new URL(url).searchParams.get('scope')).toBe('global');
  });
});

describe('normalizeScope', () => {
  it('leaves a bare global scope as global', () => {
    expect(normalizeScope('global')).toBe('global');
  });

  it('collapses identity,global to global (Heroku rejects the combination)', () => {
    expect(normalizeScope('identity,global')).toBe('global');
    expect(normalizeScope('identity global')).toBe('global');
    expect(normalizeScope(' global , identity ')).toBe('global');
  });

  it('leaves a non-global scope unchanged', () => {
    expect(normalizeScope('identity,write-protected')).toBe('identity,write-protected');
    expect(normalizeScope('write-protected')).toBe('write-protected');
    expect(normalizeScope('read')).toBe('read');
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

describe('HerokuTokenResponse schema', () => {
  // Regression: Heroku's /oauth/token returns user_id and session_nonce as
  // literal null for post-PKCE authorization-code grants. Zod's .optional()
  // accepts undefined but REJECTS null — we must use .nullish(). This bug
  // has been re-introduced twice; this test fails fast if anyone reverts.
  // See notes/divergences.md #66.
  it('accepts user_id: null and session_nonce: null (PKCE flow)', () => {
    const parsed = HerokuTokenResponse.safeParse({
      access_token: 'AT',
      refresh_token: 'RT',
      expires_in: 28800,
      token_type: 'Bearer',
      user_id: null,
      session_nonce: null,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.user_id).toBeNull();
      expect(parsed.data.session_nonce).toBeNull();
    }
  });

  it('still accepts the fields when omitted entirely', () => {
    const parsed = HerokuTokenResponse.safeParse({
      access_token: 'AT',
      refresh_token: 'RT',
      expires_in: 28800,
    });
    expect(parsed.success).toBe(true);
  });

  it('still accepts string values', () => {
    const parsed = HerokuTokenResponse.safeParse({
      access_token: 'AT',
      refresh_token: 'RT',
      expires_in: 28800,
      user_id: 'user-uuid',
      session_nonce: 'nonce-uuid',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects access_token that is missing or empty', () => {
    expect(
      HerokuTokenResponse.safeParse({
        refresh_token: 'RT',
        expires_in: 28800,
      }).success,
    ).toBe(false);
    expect(
      HerokuTokenResponse.safeParse({
        access_token: '',
        refresh_token: 'RT',
        expires_in: 28800,
      }).success,
    ).toBe(false);
  });
});

describe('exchangeAuthorizationCode — null user_id / session_nonce regression', () => {
  // End-to-end version of the schema regression: ensures that a real Heroku
  // response body with null fields makes it through exchangeAuthorizationCode
  // without throwing.
  it('parses a token response with user_id: null and session_nonce: null', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'AT',
            refresh_token: 'RT',
            expires_in: 28800,
            token_type: 'Bearer',
            user_id: null,
            session_nonce: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const res = await exchangeAuthorizationCode(
      { ...cfg, fetch: fetchMock },
      { code: 'AC', codeVerifier: 'V' },
    );
    expect(res.access_token).toBe('AT');
    expect(res.user_id).toBeNull();
    expect(res.session_nonce).toBeNull();
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
