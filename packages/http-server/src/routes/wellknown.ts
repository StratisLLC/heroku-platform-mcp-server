/**
 * OAuth 2.0 discovery documents.
 *
 *   GET /.well-known/oauth-authorization-server  (RFC 8414)
 *   GET /.well-known/oauth-protected-resource    (RFC 9728)
 *
 * Claude Desktop fetches these to learn about our authorization endpoints
 * after receiving a 401 + `WWW-Authenticate: Bearer resource_metadata=...`
 * header from /mcp. Both documents are static, derived from HEROKUMCP_PUBLIC_URL.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../auth/middleware.js';
import type { Config } from '../config.js';

export interface WellKnownDeps {
  /** Carries the resolver-backed `publicUrl` getter; read inside the handler so
   *  the lazily-resolved value is available. */
  cfg: Config;
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  scopes_supported: string[];
  service_documentation: string;
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  resource_documentation: string;
}

const SERVICE_DOC_URL = 'https://github.com/StratisLLC/heroku-platform-mcp-server';

export function buildAuthorizationServerMetadata(publicUrl: string): AuthorizationServerMetadata {
  const base = publicUrl.replace(/\/$/, '');
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    scopes_supported: [],
    service_documentation: SERVICE_DOC_URL,
  };
}

export function buildProtectedResourceMetadata(publicUrl: string): ProtectedResourceMetadata {
  const base = publicUrl.replace(/\/$/, '');
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    resource_documentation: SERVICE_DOC_URL,
  };
}

export function buildWellKnownRoutes(deps: WellKnownDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get('/.well-known/oauth-authorization-server', (c) => {
    return c.json(buildAuthorizationServerMetadata(deps.cfg.publicUrl));
  });

  router.get('/.well-known/oauth-protected-resource', (c) => {
    return c.json(buildProtectedResourceMetadata(deps.cfg.publicUrl));
  });

  return router;
}
