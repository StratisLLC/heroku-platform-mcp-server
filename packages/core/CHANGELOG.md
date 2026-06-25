# @heroku-mcp/core

## 1.1.0

### Minor Changes

- 9394f76: Phase 2b — account-tier writes, teams tier (read + write), and confirm-pattern refinement.
- 9394f76: Initial release of @heroku-mcp/core: HTTP client with retry/ratelimit/ETag handling, JSON schema fetch and cache, capability probe matrix, encrypted token storage (keychain + file backends), structured error hierarchy, JSONL audit log, secret redaction. Validated end-to-end against the Heroku Platform API.
- 9394f76: Phase 3 — Enterprise, Spaces, Add-ons (consumer), Pipelines tiers. 88 new tools (240 total). All four new probes wired in @heroku-mcp/core with comprehensive response-class coverage. Reuses registerWriteTool, canonical-name confirm, and dry_run pre-fetch primitives without modification. Shield-type private spaces require log_drain_url at creation time per schema validation.
- 9394f76: Phase 2a — apps-tier writes.

  `@heroku-mcp/core` gains two new modules:
  - `confirm.ts` — `assertConfirm`, `ConfirmationRequiredError`, and `formatConfirmationError` for the structured `confirmation_required` envelope destructive tools return when their `confirm` argument is missing or mismatched. Case-sensitive, no whitespace trimming. Extends the existing `ConfirmationMismatchError` (`kind: 'confirmation'`).
  - `dry-run.ts` — `buildDryRunResponse` plus `sanitizeHeaders`, producing the Decision-3 `{ request, description }` preview shape with Authorization/Cookie/X-Api-Key headers stripped.

  `@heroku-mcp/platform` gains 47 apps-tier write tools across nine new files: `apps-writes.ts`, `config-writes.ts`, `formation-writes.ts`, `releases-writes.ts`, `domains-writes.ts`, `logs-writes.ts`, `webhooks-writes.ts`, `collab-writes.ts`, `review-apps-writes.ts`. Tools share a single `registerWriteTool` helper (`packages/platform-mcp/src/write-tool.ts`) that:
  - Auto-injects `dry_run` (always) and `confirm` (destructive tools only) on the schema.
  - Pre-fetches the resource's current state for delete-style dry runs.
  - Gates execution behind `assertConfirm` for destructive operations.

  `dynos_run` returns dyno metadata only; rendezvous output streaming is deferred until the HTTP transport lands in Phase 4. `apps_create` is added beyond the prompt's stated list because the integration test requires it and TOOLS.md lists it. See `notes/divergences.md` for the full Phase 2a divergence log.

### Patch Changes

- 9394f76: Fix typo: rename audutFileName to auditFileName in the audit log module.
