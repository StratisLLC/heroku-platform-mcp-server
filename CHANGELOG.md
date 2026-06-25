# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) and the format follows
[Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- Sample prompts at repo root (Fleet Overview, Release & Health Investigation,
  Six-Month Usage Analysis) with a Sample MCP Prompts section in the README and landing
  page. Each prompt scopes to a single enterprise org before acting.

### Security
- Bumped `hono` to 4.12.25, clearing five advisories including the high-severity
  `hono/cors` issue (the CORS middleware is not used by this server; the bump removes
  the latent dependency regardless).
- Scoped `js-yaml` override to 4.2.0 for the dev-only 4.x copies. The remaining 3.14.2
  transitive (via the changesets release tooling) has no clean fix and is documented as
  an accepted dev-only residual in `SECURITY.md`.

---

## [1.3.2] — 2026-06-24

### Fixed
- **Auth session lifecycle (401 loop self-heal).** A stale web-session cookie could mask
  a dead or absent stored Heroku token: `/oauth/authorize` gated the Heroku bounce solely
  on the web-session cookie, minting an authorization code that then failed at session
  init and looped indefinitely. `/oauth/authorize` now re-validates the stored Heroku
  token and, on a non-transient auth-class failure, redirects to sign-in instead of
  minting a doomed code. Transient (5xx/network) failures propagate unchanged rather than
  being swallowed.
- **Token cleanup on full sign-out.** `deleteHerokuTokens` is now invoked by
  sign-out-everywhere, clearing the stored Heroku token row so a poisoned token can't
  survive a deliberate global sign-out. Plain sign-out continues to clear only the session
  cookie.

## [1.3.1] — 2026-06-23

### Fixed
- **Usage date-format validation.** The four usage tools previously shared one date-range
  input. Split into per-endpoint variants with regex validation: monthly tools require
  `YYYY-MM`, daily tools require `YYYY-MM-DD`. Malformed input is rejected with a clear
  error rather than silently coerced.

## [1.3.0] — 2026-06-23

### Changed
- **Least-privilege scope by default.** The default OAuth scope is now
  `identity,write-protected` (full platform tools, no usage/billing). Elevated access is
  an explicit opt-in: set the scope to `global`.
- **Scope normalization.** Added a guard that collapses an erroneous `identity,global` to
  the correct `global` (Heroku rejects `identity,global`).

### Added
- **Usage/billing 403 remediation messaging.** A denied usage/billing call now explains
  the two-gate requirement: `global` scope AND a Heroku user with billing/enterprise-admin
  permission. The `app.json` deploy form carries a matching warning.

## [1.2.1-diag] — 2026-06-23

### Added
- **Gated diagnostic logging.** Flag-gated reason-logging for the auth paths
  (`HEROKUMCP_AUTH_DEBUG`, `HEROKUMCP_PROBE_DEBUG`), off by default, for diagnosing
  401/session issues without changing production behavior.

## [1.2.0] — 2026-06-16

### Changed
- **Web UI rebrand.** The hosted sign-in and status pages adopt the Salesforce Lightning
  Design System palette.

## [1.1.0] — 2026-06-16

### Added
- Token-optimized `/mcp-codemode` endpoint: three discovery meta-tools (`search`,
  `execute`, `auth_status`) for on-demand tool discovery at a fraction of the initial
  context cost of the full catalog.

## [1.0.0] — 2026-06-16

First stable release. Self-hosted, OAuth-protected MCP server over HTTP with Dynamic
Client Registration, talking directly to the Heroku Platform API (no CLI). Full platform
tool catalog plus Heroku Postgres, Key-Value (Redis), and Kafka tiers, served at the flat
`/mcp` endpoint.

---

## Pre-1.0

Developed as a set of independently versioned packages from May 2026: `core`, the
`platform` tier (v0.1.0–v0.5.1), `http-server` (v0.1.0–v0.2.5), and the `postgres`,
`key-value`, and `kafka` tiers, converging into the unified 1.0.0 release on 2026-06-16.
