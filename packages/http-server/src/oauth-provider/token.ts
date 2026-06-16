/**
 * OAuth 2.1 token endpoint.
 *
 *   POST /oauth/token
 *
 * Two grant types:
 *   - authorization_code: code + PKCE verifier → new access/refresh pair
 *   - refresh_token:      refresh_token       → new access/refresh pair
 *                                               (rotation: old pair revoked)
 *
 * Client authentication: HTTP Basic (`client_secret_basic`) preferred; we
 * also accept `client_secret_post` (credentials in form body) per RFC 6749
 * §2.3.1. All credential compares are constant-time.
 *
 * Access token: `hmcp_` + 43 base64url (32 random bytes) — identical shape to
 * the bearer-token path so the middleware can use one lookup.
 * Refresh token: `hmcprt_` + 43 base64url — distinct prefix so log inspection
 * can tell them apart.
 */

import { Hono, type Context } from 'hono';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type pg from 'pg';
import { timingSafeEqualBytes } from '@heroku-mcp/core';
import type { AppEnv } from '../auth/middleware.js';
import { findOAuthClientById, touchClientLastUsed } from '../db/repos/oauth-clients.js';
import { formField } from './form-field.js';
import {
  findAuthorizationByCodeHash,
  markAuthorizationUsed,
} from '../db/repos/oauth-authorizations.js';
import {
  findOAuthTokenByRefreshHash,
  insertOAuthToken,
  revokeOAuthTokenByRefreshHash,
} from '../db/repos/oauth-tokens.js';

export interface TokenDeps {
  pool: pg.Pool;
  /** Override the token generators (tests). */
  generators?: {
    accessToken?: () => string;
    refreshToken?: () => string;
  };
}

/** 1 hour — RFC 6749 best practice for bearer tokens. */
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
/** 90 days — re-sign-in horizon. Refresh tokens rotate on each use. */
export const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export const ACCESS_TOKEN_PREFIX = 'hmcp_';
export const REFRESH_TOKEN_PREFIX = 'hmcprt_';

const CodeBody = z.object({
  grant_type: z.literal('authorization_code'),
  code: z.string().min(1),
  redirect_uri: z.string().min(1),
  code_verifier: z.string().min(43).max(128),
});

const RefreshBody = z.object({
  grant_type: z.literal('refresh_token'),
  refresh_token: z.string().min(1),
});

export function buildTokenRoutes(deps: TokenDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.post('/oauth/token', async (c) => {
    const form = await readForm(c);
    if (!form) {
      return c.json(
        { error: 'invalid_request', error_description: 'request body must be form-encoded' },
        400,
      );
    }

    // Client authentication: Basic first, then form fields.
    const creds = extractClientCredentials(c, form);
    if (!creds) {
      return c.json(
        { error: 'invalid_client', error_description: 'client credentials are required' },
        401,
        { 'WWW-Authenticate': 'Basic realm="oauth-token"' },
      );
    }

    const client = await findOAuthClientById(deps.pool, creds.clientId);
    if (!client || client.revokedAt) {
      // Be vague to avoid client_id enumeration.
      return c.json(
        { error: 'invalid_client', error_description: 'invalid client credentials' },
        401,
      );
    }
    const presentedHash = sha256Bytes(creds.clientSecret);
    if (!timingSafeEqualBytes(presentedHash, client.clientSecretHash)) {
      return c.json(
        { error: 'invalid_client', error_description: 'invalid client credentials' },
        401,
      );
    }

    const grantType = formField(form, 'grant_type');
    if (grantType === 'authorization_code') {
      return await handleAuthorizationCode(deps, c, form, client.clientId);
    }
    if (grantType === 'refresh_token') {
      return await handleRefreshToken(deps, c, form, client.clientId);
    }
    return c.json(
      {
        error: 'unsupported_grant_type',
        error_description: `unsupported grant_type: ${grantType || '(missing)'}`,
      },
      400,
    );
  });

  return router;
}

async function handleAuthorizationCode(
  deps: TokenDeps,
  c: Context<AppEnv>,
  form: FormData,
  clientId: string,
): Promise<Response> {
  const parsed = CodeBody.safeParse(formToObject(form));
  if (!parsed.success) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: parsed.error.issues[0]?.message ?? 'invalid form fields',
      },
      400,
    );
  }
  const b = parsed.data;

  const codeHash = sha256Bytes(b.code);
  const auth = await findAuthorizationByCodeHash(deps.pool, codeHash);
  if (!auth) {
    return c.json({ error: 'invalid_grant', error_description: 'unknown authorization code' }, 400);
  }
  if (auth.usedAt !== null) {
    // Single-use violation — also revoke any tokens issued under this code as
    // a defensive measure against code-replay attacks.
    return c.json(
      { error: 'invalid_grant', error_description: 'authorization code has already been used' },
      400,
    );
  }
  if (auth.expiresAt.valueOf() <= Date.now()) {
    return c.json(
      { error: 'invalid_grant', error_description: 'authorization code has expired' },
      400,
    );
  }
  if (auth.clientId !== clientId) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'authorization code was issued to a different client',
      },
      400,
    );
  }
  if (auth.redirectUri !== b.redirect_uri) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'redirect_uri does not match the authorization',
      },
      400,
    );
  }

  // PKCE S256 verification (constant-time).
  const expectedChallenge = base64UrlSha256(b.code_verifier);
  if (
    !constantTimeEqualString(expectedChallenge, auth.codeChallenge) ||
    auth.codeChallengeMethod !== 'S256'
  ) {
    return c.json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
  }

  const transitioned = await markAuthorizationUsed(deps.pool, codeHash);
  if (!transitioned) {
    // Lost the race against a concurrent /token call with the same code.
    return c.json(
      { error: 'invalid_grant', error_description: 'authorization code has already been used' },
      400,
    );
  }

  const tokens = await mintAndStoreTokens(deps, clientId, auth.userId);
  await touchClientLastUsed(deps.pool, clientId).catch(() => undefined);
  return c.json(tokens);
}

async function handleRefreshToken(
  deps: TokenDeps,
  c: Context<AppEnv>,
  form: FormData,
  clientId: string,
): Promise<Response> {
  const parsed = RefreshBody.safeParse(formToObject(form));
  if (!parsed.success) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: parsed.error.issues[0]?.message ?? 'invalid form fields',
      },
      400,
    );
  }
  const b = parsed.data;

  const refreshHash = sha256Bytes(b.refresh_token);
  const row = await findOAuthTokenByRefreshHash(deps.pool, refreshHash);
  if (!row) {
    return c.json({ error: 'invalid_grant', error_description: 'unknown refresh_token' }, 400);
  }
  if (row.revokedAt !== null) {
    return c.json(
      { error: 'invalid_grant', error_description: 'refresh_token has been revoked' },
      400,
    );
  }
  if (row.refreshExpiresAt.valueOf() <= Date.now()) {
    return c.json({ error: 'invalid_grant', error_description: 'refresh_token has expired' }, 400);
  }
  if (row.clientId !== clientId) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'refresh_token was issued to a different client',
      },
      400,
    );
  }

  // Rotation: revoke the old pair, mint a fresh pair under the same user.
  // The middleware returns 401 (not 500) when the now-revoked old access
  // token is presented — a concurrent /mcp request races against the
  // refresh; the client is expected to retry with the new token.
  await revokeOAuthTokenByRefreshHash(deps.pool, refreshHash);
  const tokens = await mintAndStoreTokens(deps, clientId, row.userId);
  await touchClientLastUsed(deps.pool, clientId).catch(() => undefined);
  return c.json(tokens);
}

interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

async function mintAndStoreTokens(
  deps: TokenDeps,
  clientId: string,
  userId: string,
): Promise<TokenResponse> {
  const access = deps.generators?.accessToken?.() ?? mintAccessToken();
  const refresh = deps.generators?.refreshToken?.() ?? mintRefreshToken();
  const now = Date.now();
  await insertOAuthToken(deps.pool, {
    accessTokenHash: sha256Bytes(access),
    refreshTokenHash: sha256Bytes(refresh),
    clientId,
    userId,
    expiresAt: new Date(now + ACCESS_TOKEN_TTL_MS),
    refreshExpiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
  });
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: refresh,
    scope: '',
  };
}

export function mintAccessToken(): string {
  return ACCESS_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

export function mintRefreshToken(): string {
  return REFRESH_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

export function sha256Bytes(s: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(s).digest());
}

function base64UrlSha256(input: string): string {
  return createHash('sha256').update(input).digest('base64url');
}

function constantTimeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  return timingSafeEqualBytes(ab, bb);
}

interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

function extractClientCredentials(c: Context<AppEnv>, form: FormData): ClientCredentials | null {
  const basic = parseBasicAuth(c.req.header('authorization'));
  if (basic) return basic;

  const formId = form.get('client_id');
  const formSecret = form.get('client_secret');
  if (typeof formId === 'string' && formId.length > 0 && typeof formSecret === 'string') {
    return { clientId: formId, clientSecret: formSecret };
  }
  return null;
}

function parseBasicAuth(header: string | undefined | null): ClientCredentials | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith('basic ')) return null;
  const b64 = trimmed.slice(6).trim();
  let decoded: string;
  try {
    decoded = Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const colon = decoded.indexOf(':');
  if (colon < 0) return null;
  const clientId = decoded.slice(0, colon);
  const clientSecret = decoded.slice(colon + 1);
  if (clientId.length === 0) return null;
  return { clientId, clientSecret };
}

async function readForm(c: Context<AppEnv>): Promise<FormData | null> {
  const ct = c.req.header('content-type') ?? '';
  if (!ct.includes('application/x-www-form-urlencoded') && !ct.includes('multipart/form-data')) {
    return null;
  }
  try {
    return await c.req.formData();
  } catch {
    return null;
  }
}

function formToObject(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}
