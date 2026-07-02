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
import type { Config } from '../config.js';
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
  /** Carries the resolver-backed `publicUrl` getter (read inside the handler)
   *  for the registration_client_uri response field. */
  cfg: Config;
  /** Override the id/secret generators (tests). */
  generators?: {
    clientId?: () => string;
    clientSecret?: () => string;
  };
}

const SUPPORTED_GRANT_TYPES = new Set(['authorization_code', 'refresh_token']);
const SUPPORTED_RESPONSE_TYPES = new Set(['code']);
// `none` registers a PUBLIC client (OAuth 2.1 / RFC 7636): no client_secret,
// authenticated at the token endpoint by PKCE alone. The two confidential
// methods are unchanged.
const SUPPORTED_AUTH_METHODS = new Set(['client_secret_basic', 'client_secret_post', 'none']);
/** Auth method that designates a public (secret-less, PKCE-only) client. */
export const PUBLIC_AUTH_METHOD = 'none';

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

    const allowInsecure = envBool(process.env.HEROKUMCP_ALLOW_INSECURE_REDIRECTS);
    for (const uri of req.redirect_uris) {
      const verdict = validateRedirectUri(uri, { allowInsecure });
      if (!verdict.ok) {
        return c.json(
          {
            error: 'invalid_redirect_uri',
            error_description: verdict.reason,
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
    const grantTypes = req.grant_types ?? ['authorization_code', 'refresh_token'];
    const authMethod = req.token_endpoint_auth_method ?? 'client_secret_basic';
    const isPublic = authMethod === PUBLIC_AUTH_METHOD;

    // Public clients get no secret. We still must satisfy the NOT NULL
    // client_secret_hash column, so we store the hash of throwaway random bytes
    // that are never disclosed — guaranteeing no presented secret can ever
    // match. The token endpoint authenticates public clients by PKCE, keyed off
    // the stored token_endpoint_auth_method, and never secret-compares them.
    const clientSecret = isPublic
      ? null
      : (deps.generators?.clientSecret?.() ?? generateClientSecret());
    const clientSecretHash = sha256Bytes(clientSecret ?? generateClientSecret());

    const stored = await insertOAuthClient(deps.pool, {
      clientId,
      clientSecretHash,
      clientName: req.client_name ?? null,
      redirectUris: req.redirect_uris,
      grantTypes,
      tokenEndpointAuthMethod: authMethod,
    });

    const issuedAtSec = Math.floor(stored.createdAt.getTime() / 1000);
    const base = deps.cfg.publicUrl.replace(/\/$/, '');
    // RFC 7591: a public client's registration response carries no
    // client_secret (nor client_secret_expires_at).
    const response: Record<string, unknown> = {
      client_id: clientId,
      client_id_issued_at: issuedAtSec,
      client_name: stored.clientName,
      redirect_uris: stored.redirectUris,
      grant_types: stored.grantTypes,
      response_types: ['code'],
      token_endpoint_auth_method: stored.tokenEndpointAuthMethod,
      registration_client_uri: `${base}/oauth/register/${clientId}`,
    };
    if (!isPublic) {
      response.client_secret = clientSecret;
      // Per RFC 7591, 0 means "no expiration."
      response.client_secret_expires_at = 0;
    }
    return c.json(response, 201);
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

/**
 * RFC 2606 / reserved example domains. These are NEVER a legitimate redirect
 * host, so registration rejects them regardless of the insecure-redirects
 * escape hatch — a live client pointing at example.com is always a forgotten
 * placeholder. Exported so tests can assert the set and operators can reason
 * about it. `*.example.*` (example as a non-terminal label, e.g.
 * `www.example.com`) is rejected too, via `isExampleHost`.
 */
export const ALWAYS_BLOCKED_REDIRECT_HOSTS = [
  'example.com',
  'www.example.com',
  'example.org',
  'example.net',
] as const;

/**
 * Loopback / non-routable hosts. Blocked in production (a public server can't
 * be reached at these) but permitted when HEROKUMCP_ALLOW_INSECURE_REDIRECTS is
 * set, for local dev and testing.
 */
export const LOOPBACK_REDIRECT_HOSTS = ['localhost', '127.0.0.1', '::1', '0.0.0.0'] as const;

/** Parse a boolean-ish env value: "1"/"true" (any case) are true; unset,
 *  empty, or anything else is false. Fail-closed so production defaults to the
 *  strict behavior. */
export function envBool(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true';
}

/** Normalize a URL hostname for comparison: lowercase and strip the brackets
 *  the URL parser puts around IPv6 literals (so `http://[::1]/` → `::1`). */
function normalizeHost(hostname: string): string {
  const h = hostname.toLowerCase();
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

/** True for an RFC 2606 reserved example host, including `example` appearing as
 *  a non-terminal label (`www.example.com`, `a.example.io`). A trailing
 *  `example` label (e.g. `cursor.example`, where example is the TLD position)
 *  is NOT treated as reserved — that would be a false positive. */
function isExampleHost(host: string): boolean {
  if ((ALWAYS_BLOCKED_REDIRECT_HOSTS as readonly string[]).includes(host)) return true;
  const labels = host.split('.');
  // `example` present with a label both before AND after it → `*.example.*`.
  return labels.some((label, i) => label === 'example' && i > 0 && i < labels.length - 1);
}

export type RedirectUriVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Validate a single `redirect_uri` at registration time (RFC 7591). The goal is
 * to catch obvious placeholder / non-routable clients (example.com, localhost in
 * production) — NOT to police every client's custom scheme.
 *
 * Rules:
 *  - Must parse as an absolute URL.
 *  - http(s): host must be present, not an RFC 2606 example host (always), and
 *    not a loopback host unless the escape hatch is on. Plain `http:` is only
 *    accepted for loopback hosts with the escape hatch; everything else must be
 *    `https:`.
 *  - Any non-http(s) scheme (e.g. `cursor://`, `vscode://`, `claude-desktop://`)
 *    is allowed through the scheme/placeholder checks — desktop OAuth flows rely
 *    on these and we only require a non-empty opaque body. The placeholder-host
 *    checks apply to http/https URLs only.
 */
export function validateRedirectUri(
  uri: string,
  opts: { allowInsecure: boolean },
): RedirectUriVerdict {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return { ok: false, reason: `redirect_uri is not a valid absolute URL: ${uri}` };
  }

  if (u.protocol === 'http:' || u.protocol === 'https:') {
    const host = normalizeHost(u.hostname);
    if (!host) {
      return { ok: false, reason: `redirect_uri has an empty host: ${uri}` };
    }
    if (isExampleHost(host)) {
      return {
        ok: false,
        reason: `redirect_uri host is a reserved example domain (RFC 2606): ${uri}`,
      };
    }
    const isLoopback = (LOOPBACK_REDIRECT_HOSTS as readonly string[]).includes(host);
    if (isLoopback && !opts.allowInsecure) {
      return {
        ok: false,
        reason: `redirect_uri host is loopback/non-routable and not allowed in production (set HEROKUMCP_ALLOW_INSECURE_REDIRECTS for local dev): ${uri}`,
      };
    }
    if (u.protocol === 'http:') {
      // Plain http is only acceptable for loopback hosts under the escape hatch;
      // any routable http host must use https.
      if (isLoopback && opts.allowInsecure) return { ok: true };
      return {
        ok: false,
        reason: `redirect_uri must use https (plain http is only allowed for loopback in local dev): ${uri}`,
      };
    }
    return { ok: true };
  }

  // Custom schemes (desktop OAuth flows). Require a non-empty opaque body; do
  // not apply the placeholder-host checks — these schemes have no routable host.
  if (/^[a-z][a-z0-9+.-]*:$/i.test(u.protocol) && uri.length > u.protocol.length + 1) {
    return { ok: true };
  }
  return { ok: false, reason: `redirect_uri uses an unsupported scheme: ${uri}` };
}
