/**
 * RFC 7009 token revocation.
 *
 *   POST /oauth/revoke
 *   Authorization: Basic <client_id:client_secret>
 *   Content-Type: application/x-www-form-urlencoded
 *
 *   token=<access or refresh>
 *   token_type_hint=access_token | refresh_token   (optional)
 *
 * Returns 200 OK in all cases — even when the token is unknown — per RFC.
 * Revoking either the access or refresh side marks the matched row revoked
 * (which transitively kills the other side, since they're paired in one row).
 */

import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { timingSafeEqualBytes } from '@heroku-mcp/core';
import type { AppEnv } from '../auth/middleware.js';
import { findOAuthClientById } from '../db/repos/oauth-clients.js';
import {
  findOAuthTokenByAccessHash,
  findOAuthTokenByRefreshHash,
  revokeOAuthTokenByAccessHash,
  revokeOAuthTokenByRefreshHash,
} from '../db/repos/oauth-tokens.js';

export interface RevokeDeps {
  pool: pg.Pool;
}

export function buildRevokeRoutes(deps: RevokeDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.post('/oauth/revoke', async (c) => {
    const ct = c.req.header('content-type') ?? '';
    if (
      !ct.includes('application/x-www-form-urlencoded') &&
      !ct.includes('multipart/form-data')
    ) {
      return c.json(
        { error: 'invalid_request', error_description: 'request body must be form-encoded' },
        400,
      );
    }
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json(
        { error: 'invalid_request', error_description: 'malformed body' },
        400,
      );
    }

    const creds = extractClientCredentials(c, form);
    if (!creds) {
      return c.json(
        { error: 'invalid_client', error_description: 'client credentials are required' },
        401,
      );
    }
    const client = await findOAuthClientById(deps.pool, creds.clientId);
    if (!client) {
      return c.json({ error: 'invalid_client' }, 401);
    }
    const presentedHash = sha256Bytes(creds.clientSecret);
    if (!timingSafeEqualBytes(presentedHash, client.clientSecretHash)) {
      return c.json({ error: 'invalid_client' }, 401);
    }

    const token = String(form.get('token') ?? '');
    if (!token) {
      // Per RFC 7009 §2.1, missing `token` is invalid_request.
      return c.json(
        { error: 'invalid_request', error_description: 'token parameter is required' },
        400,
      );
    }
    const hint = String(form.get('token_type_hint') ?? '');

    const tokenHash = sha256Bytes(token);

    // Try the hinted side first; fall back to the other if no match.
    let matched = false;
    if (hint === 'refresh_token') {
      const row = await findOAuthTokenByRefreshHash(deps.pool, tokenHash);
      if (row && row.clientId === creds.clientId) {
        await revokeOAuthTokenByRefreshHash(deps.pool, tokenHash);
        matched = true;
      }
    } else {
      const row = await findOAuthTokenByAccessHash(deps.pool, tokenHash);
      if (row && row.clientId === creds.clientId) {
        await revokeOAuthTokenByAccessHash(deps.pool, tokenHash);
        matched = true;
      }
    }
    if (!matched) {
      // Try the other side regardless of hint.
      const refreshRow = await findOAuthTokenByRefreshHash(deps.pool, tokenHash);
      if (refreshRow && refreshRow.clientId === creds.clientId) {
        await revokeOAuthTokenByRefreshHash(deps.pool, tokenHash);
        matched = true;
      } else {
        const accessRow = await findOAuthTokenByAccessHash(deps.pool, tokenHash);
        if (accessRow && accessRow.clientId === creds.clientId) {
          await revokeOAuthTokenByAccessHash(deps.pool, tokenHash);
          matched = true;
        }
      }
    }
    // Per RFC 7009: respond 200 regardless of whether the token was known.
    return c.body(null, 200);
  });

  return router;
}

function sha256Bytes(s: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(s).digest());
}

interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

function extractClientCredentials(
  c: import('hono').Context<AppEnv>,
  form: FormData,
): ClientCredentials | null {
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
