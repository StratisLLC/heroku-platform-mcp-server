/**
 * OAuth 2.1 authorize endpoint.
 *
 *   GET /oauth/authorize?response_type=code&client_id=...&redirect_uri=...
 *                       &code_challenge=...&code_challenge_method=S256
 *                       &state=...&scope=...
 *
 * Flow:
 *   1. Validate query params; bail with 400 + error JSON on shape problems.
 *   2. Look up client; bail with redirect-back-to-client error (or 400 if the
 *      client/redirect_uri is invalid — per RFC 6749 §4.1.2.1 those errors
 *      must NOT redirect, since we can't trust the URI).
 *   3. If no web session: redirect to /sign-in?next=<this URL>. The user
 *      completes Heroku sign-in, /oauth/callback honors next= and brings them
 *      back here with a session cookie.
 *   4. With a session:
 *      - Allowlisted (D2) → skip consent, mint code, redirect to client.
 *      - Not allowlisted → render consent screen (Step 5).
 *   5. Consent POST → mint code + redirect, or redirect with error=access_denied.
 */

import { Hono } from 'hono';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type pg from 'pg';
import type { AppEnv } from '../auth/middleware.js';
import type { Config } from '../config.js';
import { findOAuthClientById, bindClientToUser } from '../db/repos/oauth-clients.js';
import { insertOAuthAuthorization } from '../db/repos/oauth-authorizations.js';
import { fetchTeams } from '../oauth/heroku.js';
import { resolveUserAccessToken } from '../oauth/flow.js';
import { evaluateAccess } from '../access/allowlist.js';
import { renderConsent } from '../views/consent.js';
import type { HerokuOAuthConfig } from '../oauth/heroku.js';

/** RFC 6749 §3.1.1 — code is the only response_type we support. */
const AuthorizeQuery = z.object({
  response_type: z.literal('code'),
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  code_challenge: z
    .string()
    .min(43)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/, 'code_challenge must be base64url'),
  code_challenge_method: z.literal('S256'),
  state: z.string().optional(),
  scope: z.string().optional(),
});

/** Authorization codes live 10 minutes — Claude Desktop completes the round
 *  trip in seconds; 10 min absorbs network/user delays without being so long
 *  that a leaked URL is reusable. */
export const AUTH_CODE_TTL_MS = 10 * 60 * 1000;

export interface AuthorizeDeps {
  pool: pg.Pool;
  cfg: Config;
  oauthCfg: HerokuOAuthConfig;
  /** Override the code generator (tests). */
  generateCode?: () => string;
}

export function buildAuthorizeRoutes(deps: AuthorizeDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get('/oauth/authorize', async (c) => {
    const queryParsed = AuthorizeQuery.safeParse({
      response_type: c.req.query('response_type'),
      client_id: c.req.query('client_id'),
      redirect_uri: c.req.query('redirect_uri'),
      code_challenge: c.req.query('code_challenge'),
      code_challenge_method: c.req.query('code_challenge_method'),
      state: c.req.query('state'),
      scope: c.req.query('scope'),
    });
    if (!queryParsed.success) {
      const issue = queryParsed.error.issues[0];
      return c.json(
        {
          error: 'invalid_request',
          error_description: issue
            ? `${issue.path.join('.')}: ${issue.message}`
            : 'invalid request',
        },
        400,
      );
    }
    const q = queryParsed.data;

    const client = await findOAuthClientById(deps.pool, q.client_id);
    if (!client) {
      return c.json(
        { error: 'invalid_client', error_description: 'unknown client_id' },
        400,
      );
    }
    if (client.revokedAt) {
      return c.json(
        { error: 'invalid_client', error_description: 'client has been revoked' },
        400,
      );
    }
    if (!client.redirectUris.includes(q.redirect_uri)) {
      // Per RFC 6749 §4.1.2.1, must NOT redirect when redirect_uri itself is
      // invalid — the URI is untrusted.
      return c.json(
        {
          error: 'invalid_redirect_uri',
          error_description: 'redirect_uri does not match a registered URI for this client',
        },
        400,
      );
    }

    const auth = c.get('auth');
    if (auth?.kind !== 'web') {
      // No session — kick off Heroku sign-in, return here on completion.
      const next = currentAuthorizeUrl(c);
      return c.redirect(`/sign-in?next=${encodeURIComponent(next)}`);
    }

    // Determine if the user is pre-authorized (D2) — if so, skip consent.
    const allowlisted = await isAllowlistedUser(deps, auth.user.id, auth.user.email);
    if (allowlisted) {
      return await issueCodeAndRedirect(deps, c, {
        clientId: client.clientId,
        userId: auth.user.id,
        redirectUri: q.redirect_uri,
        codeChallenge: q.code_challenge,
        codeChallengeMethod: q.code_challenge_method,
        state: q.state,
        scope: q.scope,
      });
    }

    // Consent screen — POST back to /oauth/consent with the parameters.
    return c.html(
      renderConsent(
        {
          signedIn: true,
          admin: auth.isAdmin,
          currentPath: '/oauth/authorize',
        },
        {
          clientName: client.clientName ?? client.clientId,
          clientId: client.clientId,
          redirectUri: q.redirect_uri,
          codeChallenge: q.code_challenge,
          codeChallengeMethod: q.code_challenge_method,
          state: q.state ?? null,
          scope: q.scope ?? null,
          userEmail: auth.user.email,
        },
      ),
    );
  });

  router.post('/oauth/consent', async (c) => {
    const auth = c.get('auth');
    if (auth?.kind !== 'web') return c.redirect('/sign-in');

    const form = await c.req.formData();
    const decision = String(form.get('decision') ?? '');
    const clientId = String(form.get('client_id') ?? '');
    const redirectUri = String(form.get('redirect_uri') ?? '');
    const codeChallenge = String(form.get('code_challenge') ?? '');
    const codeChallengeMethod = String(form.get('code_challenge_method') ?? '');
    const stateField = form.get('state');
    const state = stateField === null ? undefined : String(stateField);
    const scopeField = form.get('scope');
    const scope = scopeField === null ? undefined : String(scopeField);

    const client = await findOAuthClientById(deps.pool, clientId);
    if (!client || client.revokedAt) {
      return c.json({ error: 'invalid_client' }, 400);
    }
    if (!client.redirectUris.includes(redirectUri)) {
      return c.json({ error: 'invalid_redirect_uri' }, 400);
    }

    if (decision !== 'allow') {
      const redir = new URL(redirectUri);
      redir.searchParams.set('error', 'access_denied');
      redir.searchParams.set('error_description', 'user denied the authorization request');
      if (state) redir.searchParams.set('state', state);
      return c.redirect(redir.toString());
    }

    return await issueCodeAndRedirect(deps, c, {
      clientId,
      userId: auth.user.id,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      state,
      scope,
    });
  });

  return router;
}

interface IssueCodeInput {
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state?: string | undefined;
  scope?: string | undefined;
}

async function issueCodeAndRedirect(
  deps: AuthorizeDeps,
  c: import('hono').Context<AppEnv>,
  input: IssueCodeInput,
): Promise<Response> {
  const code = deps.generateCode?.() ?? generateAuthCode();
  const codeHash = sha256Bytes(code);
  await insertOAuthAuthorization(deps.pool, {
    codeHash,
    clientId: input.clientId,
    userId: input.userId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallengeMethod,
    scope: input.scope ?? null,
    state: input.state ?? null,
    expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
  });
  await bindClientToUser(deps.pool, input.clientId, input.userId).catch(() => undefined);
  const redir = new URL(input.redirectUri);
  redir.searchParams.set('code', code);
  if (input.state) redir.searchParams.set('state', input.state);
  return c.redirect(redir.toString());
}

/** Compute whether the user is in the allowlist (skips consent). When no
 *  allowlist is configured at all, the deployment is "open" — we still show
 *  consent so users see what they're approving. Only an explicitly-allowlisted
 *  user skips it (D2). */
async function isAllowlistedUser(
  deps: AuthorizeDeps,
  userId: string,
  email: string,
): Promise<boolean> {
  const hasEmails = (deps.cfg.allowedEmails?.length ?? 0) > 0;
  const hasTeams = (deps.cfg.allowedTeams?.length ?? 0) > 0;
  if (!hasEmails && !hasTeams) return false;

  let teams: string[] = [];
  if (hasTeams) {
    try {
      const accessToken = await resolveUserAccessToken(
        deps.pool,
        userId,
        deps.cfg.masterKey,
      );
      const t = await fetchTeams(deps.oauthCfg, accessToken);
      teams = t.map((x) => x.name);
    } catch {
      teams = [];
    }
  }
  const decision = evaluateAccess(
    { email, herokuId: '', teams },
    {
      allowedEmails: deps.cfg.allowedEmails,
      allowedTeams: deps.cfg.allowedTeams,
    },
  );
  return decision.allowed;
}

/** Reconstruct the current /oauth/authorize?... URL so /sign-in can return
 *  here after a successful Heroku sign-in. We use the path + raw query — the
 *  next= field is restricted to same-origin paths by the callback. */
function currentAuthorizeUrl(c: import('hono').Context<AppEnv>): string {
  const url = new URL(c.req.url);
  return `${url.pathname}${url.search}`;
}

/** 32 hex chars (16 random bytes) — same shape as client_id; lookup is by
 *  SHA-256 hash so the byte length doesn't matter cryptographically. */
export function generateAuthCode(): string {
  return randomBytes(16).toString('hex');
}

export function sha256Bytes(s: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(s).digest());
}
