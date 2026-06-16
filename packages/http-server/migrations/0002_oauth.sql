-- Heroku MCP — Phase 4.5 OAuth provider tables.
--
-- Adds an OAuth 2.1 authorization-server layer on top of the existing bearer-
-- token machinery. The bearer-token path (connection_tokens) is untouched;
-- this migration is additive.
--
-- Three new tables:
--   oauth_clients         — DCR-registered clients (Claude Desktop, etc.).
--   oauth_authorizations  — short-lived PKCE auth codes (single-use, ~10min TTL).
--   oauth_tokens          — issued access/refresh token pairs (1h / 90d).
--
-- The middleware tries oauth_tokens first, falls back to connection_tokens, so
-- the same `Authorization: Bearer hmcp_...` header works for both paths.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id                  text PRIMARY KEY,
  client_secret_hash         bytea NOT NULL,
  client_name                text,
  redirect_uris              text[] NOT NULL,
  grant_types                text[] NOT NULL DEFAULT ARRAY['authorization_code', 'refresh_token']::text[],
  token_endpoint_auth_method text NOT NULL DEFAULT 'client_secret_basic',
  user_id                    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  last_used_at               timestamptz,
  revoked_at                 timestamptz
);

CREATE INDEX IF NOT EXISTS oauth_clients_user_idx
  ON oauth_clients(user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS oauth_authorizations (
  code_hash             bytea PRIMARY KEY,
  client_id             text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri          text NOT NULL,
  code_challenge        text NOT NULL,
  code_challenge_method text NOT NULL DEFAULT 'S256',
  scope                 text,
  state                 text,
  expires_at            timestamptz NOT NULL,
  used_at               timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_authorizations_expiry
  ON oauth_authorizations(expires_at);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  access_token_hash    bytea PRIMARY KEY,
  refresh_token_hash   bytea NOT NULL UNIQUE,
  client_id            text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at           timestamptz NOT NULL,
  refresh_expires_at   timestamptz NOT NULL,
  revoked_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user_client
  ON oauth_tokens(user_id, client_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_refresh_hash
  ON oauth_tokens(refresh_token_hash) WHERE revoked_at IS NULL;
