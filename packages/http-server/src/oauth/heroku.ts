/**
 * Heroku OAuth client: authorize URL construction, code exchange, refresh,
 * and the `GET /account` + `GET /teams` follow-ups we need for sign-in.
 *
 * The fetch dependency is injectable so tests can stub Heroku's HTTP surface
 * without hitting the network.
 */

import { z } from 'zod';

export const HerokuTokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  token_type: z.string().optional(),
  user_id: z.string().nullish(),
  session_nonce: z.string().nullish(),
});
export type HerokuTokenResponse = z.infer<typeof HerokuTokenResponse>;

export const HerokuAccount = z.object({
  id: z.string().min(1),
  email: z.string().min(1),
  name: z.string().nullable().optional(),
  default_organization: z.object({ name: z.string().nullable().optional() }).nullable().optional(),
  default_team: z.object({ name: z.string().nullable().optional() }).nullable().optional(),
});
export type HerokuAccount = z.infer<typeof HerokuAccount>;

export const HerokuTeam = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});
export type HerokuTeam = z.infer<typeof HerokuTeam>;

export interface HerokuOAuthConfig {
  clientId: string;
  clientSecret: string;
  scope: string;
  /** Where Heroku should redirect users back to. */
  redirectUri: string;
  authorizeUrl: string;
  tokenUrl: string;
  apiBaseUrl: string;
  fetch?: typeof globalThis.fetch;
  userAgent?: string;
}

export interface BuildAuthorizeUrlOptions {
  state: string;
  codeChallenge: string;
}

/**
 * Normalise an OAuth scope string before it goes on the authorize URL.
 *
 * Heroku rejects `global` combined with any other scope ("permissions of
 * global are a superset of identity"), so if the requested scopes include
 * `global` we collapse the whole value to exactly `global`. This makes both a
 * correct `global` and a mistakenly-typed `identity,global` work. When `global`
 * is absent the value is returned unchanged. Pure string transform — no network.
 */
export function normalizeScope(scope: string): string {
  const tokens = scope.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
  if (tokens.includes('global')) return 'global';
  return scope;
}

/** Build the URL we redirect the user's browser to on /sign-in. */
export function buildAuthorizeUrl(cfg: HerokuOAuthConfig, opts: BuildAuthorizeUrlOptions): string {
  const u = new URL(cfg.authorizeUrl);
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', normalizeScope(cfg.scope));
  u.searchParams.set('state', opts.state);
  u.searchParams.set('code_challenge', opts.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('redirect_uri', cfg.redirectUri);
  return u.toString();
}

export interface ExchangeCodeInput {
  code: string;
  codeVerifier: string;
}

/** Exchange an auth code for tokens at id.heroku.com/oauth/token. */
export async function exchangeAuthorizationCode(
  cfg: HerokuOAuthConfig,
  input: ExchangeCodeInput,
): Promise<HerokuTokenResponse> {
  const form = new URLSearchParams();
  form.set('grant_type', 'authorization_code');
  form.set('code', input.code);
  form.set('client_secret', cfg.clientSecret);
  form.set('code_verifier', input.codeVerifier);
  form.set('redirect_uri', cfg.redirectUri);
  return postFormForToken(cfg, form);
}

/** Refresh an access token. */
export async function refreshAccessToken(
  cfg: HerokuOAuthConfig,
  refreshToken: string,
): Promise<HerokuTokenResponse> {
  const form = new URLSearchParams();
  form.set('grant_type', 'refresh_token');
  form.set('refresh_token', refreshToken);
  form.set('client_secret', cfg.clientSecret);
  return postFormForToken(cfg, form);
}

/** GET /account using the supplied access token. */
export async function fetchAccount(
  cfg: HerokuOAuthConfig,
  accessToken: string,
): Promise<HerokuAccount> {
  const fetchFn = cfg.fetch ?? globalThis.fetch;
  const res = await fetchFn(`${cfg.apiBaseUrl}/account`, {
    method: 'GET',
    headers: herokuHeaders(accessToken, cfg.userAgent),
  });
  if (!res.ok) {
    throw new HerokuOAuthError(
      `GET /account failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
      res.status,
    );
  }
  const body = await res.json();
  return HerokuAccount.parse(body);
}

/** GET /teams. Returns empty array on 403/404 (the scope may not include
 *  team listing). */
export async function fetchTeams(
  cfg: HerokuOAuthConfig,
  accessToken: string,
): Promise<HerokuTeam[]> {
  const fetchFn = cfg.fetch ?? globalThis.fetch;
  const res = await fetchFn(`${cfg.apiBaseUrl}/teams`, {
    method: 'GET',
    headers: herokuHeaders(accessToken, cfg.userAgent),
  });
  if (res.status === 403 || res.status === 404) return [];
  if (!res.ok) {
    throw new HerokuOAuthError(`GET /teams failed (${res.status})`, res.status);
  }
  const body = await res.json();
  return z.array(HerokuTeam).parse(body);
}

/** Heroku-specific OAuth error. Caller decides whether to surface the message
 *  (typically as a denial page). */
export class HerokuOAuthError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'HerokuOAuthError';
  }
}

function herokuHeaders(accessToken: string, userAgent?: string): Record<string, string> {
  return {
    Accept: 'application/vnd.heroku+json; version=3',
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': userAgent ?? 'herokumcp-http-server',
  };
}

async function postFormForToken(
  cfg: HerokuOAuthConfig,
  form: URLSearchParams,
): Promise<HerokuTokenResponse> {
  const fetchFn = cfg.fetch ?? globalThis.fetch;
  const res = await fetchFn(cfg.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': cfg.userAgent ?? 'herokumcp-http-server',
    },
    body: form.toString(),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    const code = isRec(body) && typeof body.error === 'string' ? body.error : undefined;
    const message =
      isRec(body) && typeof body.error_description === 'string'
        ? body.error_description
        : `token endpoint returned ${res.status}`;
    throw new HerokuOAuthError(message, res.status, code);
  }
  const parsed = HerokuTokenResponse.safeParse(body);
  if (!parsed.success) {
    throw new HerokuOAuthError('token endpoint returned an unexpected shape');
  }
  return parsed.data;
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
