-- Heroku MCP — Phase 4 initial schema.
--
-- The hosted server stores: users (one per Heroku account that ever signed in),
-- heroku_tokens (envelope-encrypted OAuth tokens per user), connection_tokens
-- (hashed Bearer tokens Claude clients present), and audit_log (every
-- observable event). All bytea columns hold envelope-encoded blobs from
-- @heroku-mcp/core's crypto module.
--
-- Idempotent migration: safe to run multiple times against a partially-
-- migrated database.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  heroku_id       text UNIQUE NOT NULL,
  email           text NOT NULL,
  default_team    text,
  signed_in_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_email_idx ON users(email);

CREATE TABLE IF NOT EXISTS heroku_tokens (
  user_id                   uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  encrypted_access_token    bytea NOT NULL,
  encrypted_refresh_token   bytea NOT NULL,
  encrypted_dek             bytea NOT NULL,
  expires_at                timestamptz NOT NULL,
  refreshed_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS connection_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    bytea NOT NULL UNIQUE,
  label         text,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX IF NOT EXISTS connection_tokens_user_idx
  ON connection_tokens(user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS connection_tokens_hash_idx
  ON connection_tokens(token_hash) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS audit_log (
  id             bigserial PRIMARY KEY,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  event_category text NOT NULL,
  event_name     text NOT NULL,
  status         text NOT NULL,
  request_id     text,
  duration_ms    integer,
  client_name    text,
  client_version text,
  details        jsonb
);
CREATE INDEX IF NOT EXISTS audit_log_user_occurred_idx
  ON audit_log(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_occurred_idx
  ON audit_log(occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_event_idx
  ON audit_log(event_category, event_name);

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
