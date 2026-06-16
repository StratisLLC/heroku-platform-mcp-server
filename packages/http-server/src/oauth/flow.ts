/**
 * Sign-in orchestration.
 *
 *   beginSignIn   — generate state + PKCE, store in flow cookie, return URL.
 *   completeSignIn — handle callback: exchange code, fetch identity, upsert
 *                    user, persist encrypted tokens, mint connection token.
 */

import {
  decodeFromStorage,
  decryptWithDek,
  decryptWithKek,
  encodeForStorage,
  encryptWithDek,
  encryptWithKek,
  generateDek,
} from '@heroku-mcp/core';
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  fetchAccount,
  fetchTeams,
  HerokuOAuthError,
  refreshAccessToken,
  type HerokuOAuthConfig,
  type HerokuAccount,
  type HerokuTeam,
} from './heroku.js';
import { makePkcePair, makeStateToken } from './pkce.js';
import { mintConnectionToken, type MintedToken } from '../auth/connection-token.js';
import { upsertUser, type UserRow } from '../db/repos/users.js';
import { findHerokuTokens, upsertHerokuTokens } from '../db/repos/heroku-tokens.js';
import { issueConnectionToken } from '../db/repos/connection-tokens.js';
import { withTransaction } from '../db/pool.js';
import type pg from 'pg';
import type { OAuthFlowState } from '../auth/session.js';
import { evaluateAccess, type AccessDecision, type AllowlistConfig } from '../access/allowlist.js';

export interface BeginSignInResult {
  redirectUrl: string;
  flowState: OAuthFlowState;
}

/** Build the OAuth flow state to seal into the cookie and the Heroku URL to
 *  redirect to. */
export function beginSignIn(
  cfg: HerokuOAuthConfig,
  opts: { redirectAfterLogin?: string } = {},
): BeginSignInResult {
  const pkce = makePkcePair();
  const state = makeStateToken();
  const flowState: OAuthFlowState = {
    state,
    pkceVerifier: pkce.verifier,
    redirectAfterLogin: opts.redirectAfterLogin ?? '/me',
    createdAt: Date.now(),
  };
  const redirectUrl = buildAuthorizeUrl(cfg, { state, codeChallenge: pkce.challenge });
  return { redirectUrl, flowState };
}

export interface CompleteSignInInput {
  /** Auth code from Heroku's redirect. */
  code: string;
  /** State token from Heroku's redirect. */
  state: string;
  /** Pre-sign-in flow state from the cookie. */
  flow: OAuthFlowState;
}

export interface CompleteSignInResult {
  user: UserRow;
  account: HerokuAccount;
  teams: HerokuTeam[];
  newConnectionToken: MintedToken;
  /** Where the sign-in initiator wanted to land. */
  redirectAfterLogin: string;
}

export interface CompleteSignInDeps {
  pool: pg.Pool;
  cfg: HerokuOAuthConfig;
  masterKey: Uint8Array;
  allowlist: AllowlistConfig;
  /** Override the new-token mint (tests). */
  mint?: () => MintedToken;
  /** Set a label on the issued connection token. */
  tokenLabel?: string;
}

export class SignInError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | 'state_mismatch'
      | 'token_exchange'
      | 'identity_fetch'
      | 'access_denied'
      | 'persist',
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SignInError';
  }
}

/** Drive the callback through token exchange, identity fetch, access check,
 *  encryption, persistence, and connection-token minting. */
export async function completeSignIn(
  input: CompleteSignInInput,
  deps: CompleteSignInDeps,
): Promise<CompleteSignInResult> {
  if (input.state !== input.flow.state) {
    throw new SignInError('OAuth state mismatch.', 'state_mismatch');
  }

  let tokenRes;
  try {
    tokenRes = await exchangeAuthorizationCode(deps.cfg, {
      code: input.code,
      codeVerifier: input.flow.pkceVerifier,
    });
  } catch (err) {
    throw new SignInError(
      err instanceof Error ? err.message : 'Token exchange failed',
      'token_exchange',
    );
  }

  let account: HerokuAccount;
  let teams: HerokuTeam[];
  try {
    account = await fetchAccount(deps.cfg, tokenRes.access_token);
    teams = await fetchTeams(deps.cfg, tokenRes.access_token);
  } catch (err) {
    throw new SignInError(
      err instanceof Error ? err.message : 'Identity fetch failed',
      'identity_fetch',
    );
  }

  const teamNames = teams.map((t) => t.name);
  const access: AccessDecision = evaluateAccess(
    { email: account.email, herokuId: account.id, teams: teamNames },
    deps.allowlist,
  );
  if (!access.allowed) {
    throw new SignInError('Access denied by allowlist.', 'access_denied', {
      reason: access.reason,
      account,
      teams: teamNames,
    });
  }

  // Encrypt: fresh DEK per first-time user (or rotate on re-sign-in? — current
  // behavior rotates so that any prior session's leaked DEK becomes inert
  // after the user signs in again).
  const dek = generateDek();
  const accessBlob = encodeForStorage(
    encryptWithDek(new TextEncoder().encode(tokenRes.access_token), dek),
  );
  const refreshBlob = encodeForStorage(
    encryptWithDek(new TextEncoder().encode(tokenRes.refresh_token), dek),
  );
  const dekBlob = encodeForStorage(encryptWithKek(dek, deps.masterKey));

  const mintFn = deps.mint ?? mintConnectionToken;
  const minted = mintFn();
  const expiresAt = new Date(Date.now() + tokenRes.expires_in * 1000);

  let user: UserRow;
  try {
    user = await withTransaction(deps.pool, async (client) => {
      const u = await upsertUser(client, {
        herokuId: account.id,
        email: account.email,
        defaultTeam: account.default_team?.name ?? account.default_organization?.name ?? null,
      });
      await upsertHerokuTokens(client, {
        userId: u.id,
        encryptedAccessToken: accessBlob,
        encryptedRefreshToken: refreshBlob,
        encryptedDek: dekBlob,
        expiresAt,
      });
      await issueConnectionToken(client, {
        userId: u.id,
        tokenHash: minted.hash,
        label: deps.tokenLabel ?? 'Issued at sign-in',
      });
      return u;
    });
  } catch (err) {
    throw new SignInError(err instanceof Error ? err.message : 'Persistence failed', 'persist');
  }

  return {
    user,
    account,
    teams,
    newConnectionToken: minted,
    redirectAfterLogin: input.flow.redirectAfterLogin,
  };
}

/** Thrown when the stored refresh token is itself rejected by Heroku, meaning
 *  the underlying authorization has been revoked or has expired past its
 *  longer TTL. The user must sign in again — there is no recovery short of
 *  the full OAuth flow. Surfaced from the request path with a clear envelope
 *  so the capability prober (and Claude Desktop) can show a useful message
 *  instead of a generic 401. */
export class ReauthRequiredError extends Error {
  /** Stable shape/code so callers in other packages can recognise it without
   *  importing the class (e.g. the prober wrapper in core). */
  readonly code = 'reauth_required' as const;
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ReauthRequiredError';
  }
}

/** Buffer applied to expires_at when deciding whether to proactively refresh.
 *  60s gives clock skew + in-flight request headroom without being so large
 *  that we refresh on every request near the end of a session. */
const REFRESH_EXPIRY_BUFFER_MS = 60_000;

/** Decrypt the Heroku access token for a user, refreshing it first if the
 *  stored token has expired or is within the {@link REFRESH_EXPIRY_BUFFER_MS}
 *  buffer of expiry. Throws {@link ReauthRequiredError} when Heroku rejects
 *  the refresh token (authorization revoked / refresh-token TTL exceeded). */
export async function resolveUserAccessToken(
  pool: pg.Pool,
  userId: string,
  masterKey: Uint8Array,
  oauthCfg: HerokuOAuthConfig,
  opts: { now?: () => number } = {},
): Promise<string> {
  const row = await findHerokuTokens(pool, userId);
  if (!row) {
    throw new Error('No stored Heroku tokens for user');
  }
  const dek = decryptWithKek(decodeFromStorage(row.encryptedDek), masterKey);
  const accessBytes = decryptWithDek(decodeFromStorage(row.encryptedAccessToken), dek);
  const accessToken = new TextDecoder().decode(accessBytes);

  const now = opts.now ?? Date.now;
  const expiresAtMs = row.expiresAt.valueOf();
  if (expiresAtMs - REFRESH_EXPIRY_BUFFER_MS > now()) {
    return accessToken;
  }

  // Token is expired or about to expire — refresh it.
  const refreshBytes = decryptWithDek(decodeFromStorage(row.encryptedRefreshToken), dek);
  const refreshToken = new TextDecoder().decode(refreshBytes);

  let refreshed;
  try {
    refreshed = await refreshAccessToken(oauthCfg, refreshToken);
  } catch (err) {
    if (err instanceof HerokuOAuthError) {
      // Heroku 4xx on the refresh endpoint means the refresh token itself is
      // no longer valid — the user has to re-authenticate. Anything else (5xx
      // / network) is transient and bubbles up unchanged for the caller to
      // retry.
      const status = err.status ?? 0;
      if (status >= 400 && status < 500) {
        throw new ReauthRequiredError(
          'Your Heroku authorization has expired or been revoked. Sign out and reconnect to continue.',
          err,
        );
      }
    }
    throw err;
  }

  // Persist the rotated tokens (Heroku always returns a fresh refresh_token
  // alongside the new access_token). Reuse the existing DEK; the master key
  // can still unwrap it, and rotating the DEK on every refresh would churn
  // the wrapping for no security gain.
  const newAccessBlob = encodeForStorage(
    encryptWithDek(new TextEncoder().encode(refreshed.access_token), dek),
  );
  const newRefreshBlob = encodeForStorage(
    encryptWithDek(new TextEncoder().encode(refreshed.refresh_token), dek),
  );
  const newExpiresAt = new Date(now() + refreshed.expires_in * 1000);
  await upsertHerokuTokens(pool, {
    userId,
    encryptedAccessToken: newAccessBlob,
    encryptedRefreshToken: newRefreshBlob,
    encryptedDek: row.encryptedDek,
    expiresAt: newExpiresAt,
  });

  return refreshed.access_token;
}
