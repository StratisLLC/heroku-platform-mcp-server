---
'@heroku-mcp/core': minor
'@heroku-mcp/platform': minor
---

Phase 2a — apps-tier writes.

`@heroku-mcp/core` gains two new modules:

- `confirm.ts` — `assertConfirm`, `ConfirmationRequiredError`, and `formatConfirmationError` for the structured `confirmation_required` envelope destructive tools return when their `confirm` argument is missing or mismatched. Case-sensitive, no whitespace trimming. Extends the existing `ConfirmationMismatchError` (`kind: 'confirmation'`).
- `dry-run.ts` — `buildDryRunResponse` plus `sanitizeHeaders`, producing the Decision-3 `{ request, description }` preview shape with Authorization/Cookie/X-Api-Key headers stripped.

`@heroku-mcp/platform` gains 47 apps-tier write tools across nine new files: `apps-writes.ts`, `config-writes.ts`, `formation-writes.ts`, `releases-writes.ts`, `domains-writes.ts`, `logs-writes.ts`, `webhooks-writes.ts`, `collab-writes.ts`, `review-apps-writes.ts`. Tools share a single `registerWriteTool` helper (`packages/platform-mcp/src/write-tool.ts`) that:

- Auto-injects `dry_run` (always) and `confirm` (destructive tools only) on the schema.
- Pre-fetches the resource's current state for delete-style dry runs.
- Gates execution behind `assertConfirm` for destructive operations.

`dynos_run` returns dyno metadata only; rendezvous output streaming is deferred until the HTTP transport lands in Phase 4. `apps_create` is added beyond the prompt's stated list because the integration test requires it and TOOLS.md lists it. See `notes/divergences.md` for the full Phase 2a divergence log.
