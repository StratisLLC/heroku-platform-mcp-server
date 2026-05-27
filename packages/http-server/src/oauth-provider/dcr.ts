/**
 * Dynamic Client Registration (RFC 7591).
 *
 *   POST /oauth/register
 *
 * Open registration (D1): anyone can register. The real security boundary is
 * the user-allowlist check during /oauth/authorize; a client with no allowed
 * user behind it can't complete the code-grant flow.
 */

import { Hono } from 'hono';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type pg from 'pg';
import type { AppEnv } from '../auth/middleware.js';
import { insertOAuthClient } from '../db/repos/oauth-clients.js';

/** RFC 7591 registration request — we accept the common fields and ignore the
 *  rest. Anything we don't validate, we don't store. */
const RegisterRequest = z.object({
  client_name: z.string().min(1).max(200).optional(),
  redirect_uris: z.array(z.string().min(1)).min(1),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
  scope: z.string().optional(),
});

export interface DcrDeps {
  pool: pg.Pool;
  /** Base URL for the registration_client_uri response field. */
  publicUrl: string;
  /** Override the id/secret generators (tests). */
  generators?: {
    clientId?: () => string;
    clientSecret?: () => string;
  };
}

const SUPPORTED_GRANT_TYPES = new Set(['authorization_code', 'refresh_token']);
const SUPPORTED_RESPONSE_TYPES = new Set(['code']);
const SUPPORTED_AUTH_METHODS = new Set(['client_secret_basic', 'client_secret_post']);

export function buildDcrRoutes(deps: DcrDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.post('/oauth/register', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: 'invalid_client_metadata', error_description: 'request body must be JSON' },
        400,
      );
    }

    const parsed = RegisterRequest.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json(
        {
          error: 'invalid_client_metadata',
          error_description: issue
            ? `${issue.path.join('.')}: ${issue.message}`
            : 'invalid client metadata',
        },
        400,
      );
    }

    const req = parsed.data;

    for (const uri of req.redirect_uris) {
      if (!isValidRedirectUri(uri)) {
        return c.json(
          {
            error: 'invalid_redirect_uri',
            error_description: `redirect_uri must be an absolute http(s) URL: ${uri}`,
          },
          400,
        );
      }
    }

    if (req.grant_types) {
      for (const g of req.grant_types) {
        if (!SUPPORTED_GRANT_TYPES.has(g)) {
          return c.json(
            {
              error: 'invalid_client_metadata',
              error_description: `unsupported grant_type: ${g}`,
            },
            400,
          );
        }
      }
    }
    if (req.response_types) {
      for (const r of req.response_types) {
        if (!SUPPORTED_RESPONSE_TYPES.has(r)) {
          return c.json(
            {
              error: 'invalid_client_metadata',
              error_description: `unsupported response_type: ${r}`,
            },
            400,
          );
        }
      }
    }
    if (req.token_endpoint_auth_method) {
      if (!SUPPORTED_AUTH_METHODS.has(req.token_endpoint_auth_method)) {
        return c.json(
          {
            error: 'invalid_client_metadata',
            error_description: `unsupported token_endpoint_auth_method: ${req.token_endpoint_auth_method}`,
          },
          400,
        );
      }
    }

    const clientId = deps.generators?.clientId?.() ?? generateClientId();
    const clientSecret = deps.generators?.clientSecret?.() ?? generateClientSecret();
    const clientSecretHash = sha256Bytes(clientSecret);
    const grantTypes = req.grant_types ?? ['authorization_code', 'refresh_token'];
    const authMethod = req.token_endpoint_auth_method ?? 'client_secret_basic';

    const stored = await insertOAuthClient(deps.pool, {
      clientId,
      clientSecretHash,
      clientName: req.client_name ?? null,
      redirectUris: req.redirect_uris,
      grantTypes,
      tokenEndpointAuthMethod: authMethod,
    });

    const issuedAtSec = Math.floor(stored.createdAt.getTime() / 1000);
    const base = deps.publicUrl.replace(/\/$/, '');
    return c.json(
      {
        client_id: clientId,
        client_secret: clientSecret,
        // Per RFC 7591, 0 means "no expiration."
        client_secret_expires_at: 0,
        client_id_issued_at: issuedAtSec,
        client_name: stored.clientName,
        redirect_uris: stored.redirectUris,
        grant_types: stored.grantTypes,
        response_types: ['code'],
        token_endpoint_auth_method: stored.tokenEndpointAuthMethod,
        registration_client_uri: `${base}/oauth/register/${clientId}`,
      },
      201,
    );
  });

  return router;
}

/** 32 hex chars (16 random bytes). Public, OK in URLs and logs. */
export function generateClientId(): string {
  return randomBytes(16).toString('hex');
}

/** 43 base64url chars (32 random bytes). Treated like a password — only ever
 *  hashed for storage. */
export function generateClientSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256Bytes(s: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(s).digest());
}

function isValidRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    // Accept http(s); accept "claude://" custom schemes too. Reject obvious
    // garbage like file:// or javascript:.
    if (u.protocol === 'http:' || u.protocol === 'https:') return true;
    // Custom schemes (used by some desktop OAuth flows). Require non-empty
    // scheme + opaque body.
    if (/^[a-z][a-z0-9+.-]*:$/i.test(u.protocol)) return uri.length > u.protocol.length + 1;
    return false;
  } catch {
    return false;
  }
}
