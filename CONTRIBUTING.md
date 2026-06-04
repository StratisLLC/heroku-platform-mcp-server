# Contributing to herokumcp

Thanks for your interest in contributing. This document covers local development setup, the test workflow, and how to add new tools or capability tiers.

## Code of Conduct

This project follows the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). Be kind, be helpful, assume good faith.

## Reporting issues

For **bugs and feature requests**, open an issue on [GitHub](https://github.com/StratisLLC/heroku-platform-mcp-server/issues). Include:

- What you tried
- What you expected
- What happened
- Versions: `node --version`, `pnpm --version`, `@heroku-mcp/platform` version
- If reproducible, the steps

For **security vulnerabilities**, please **do not file a public issue**. See [SECURITY.md](SECURITY.md).

## Local development setup

### Prerequisites

- Node.js ≥ 20
- pnpm 9.x (`npm install -g pnpm@9` if needed)
- A Heroku account with API access (the [Heroku CLI](https://devcenter.heroku.com/articles/heroku-cli) installed and authenticated)
- An `HRKU-...` API token for integration tests (generated via `heroku authorizations:create -d "herokumcp dev"`)

### First-time setup

```bash
git clone https://github.com/StratisLLC/heroku-platform-mcp-server.git
cd herokumcp
pnpm install
pnpm -r build
pnpm -r test
```

That should produce green output across both packages. If anything fails on a clean clone, please open an issue.

### Daily development loop

```bash
# Run during active development
pnpm -r typecheck   # fast, run after most edits
pnpm -r test        # unit tests, mocked HTTP

# Run before committing
pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r format:check && pnpm -r test

# Run when you've changed anything that touches Heroku API call paths
export HEROKUMCP_TEST_TOKEN="HRKU-..."
pnpm -r test:integration
```

### Auto-formatting

```bash
pnpm -r format       # fix prettier issues
pnpm -r lint -- --fix  # fix auto-fixable eslint issues
```

## Project layout

```
herokumcp/
├── packages/
│   ├── core/                — shared library: HTTP client, prober, errors,
│   │                          token store, audit log, secret redaction
│   └── platform-mcp/        — customer-facing MCP server (stdio in v1,
│                              HTTP added in Phase 4)
├── docs/                    — user-facing documentation (growing in
│                              later phases)
├── notes/                   — internal notes (divergence log, etc.)
└── ARCHITECTURE.md, ...     — design docs (will move into docs/ at 1.0)
```

For the full design and the planned shape of additional packages, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Adding a new tool

The pattern is consistent across all read and write tools.

### A read tool

1. Pick or create the right file in `packages/platform-mcp/src/tools/` — group by resource (e.g. `apps.ts` for apps-related reads, `teams.ts` for teams-related reads).
2. Register the tool inside the file's `register*Tools(context)` function using `context.server.registerTool(...)`.
3. The handler should call `context.client.get(path, options)` and return the response wrapped in the standard envelope using the `wrapSuccess` helper.
4. Add a unit test in `packages/platform-mcp/test/tools/<file>.test.ts` mocking the client.
5. If the tool is in a new capability tier, also add an integration test (`platform.integration.test.ts`).
6. Update [TOOLS.md](TOOLS.md) with the new tool's entry.

### A write tool

Use the `registerWriteTool` helper from `packages/platform-mcp/src/write-tool.ts`. It auto-injects `dry_run` (always) and `confirm` (when `destructive: true`), handles pre-fetch for delete operations, gates execution behind `assertConfirm`, and returns the standard envelope.

```ts
registerWriteTool(context, {
  name: 'my_resource_delete',
  description: 'Delete a my-resource.',
  tier: 'apps',
  destructive: true,
  confirmTarget: (params) => params.name as string,
  inputSchema: z.object({
    name: z.string(),
  }),
  buildRequest: (params) => ({
    method: 'DELETE',
    path: `/my-resources/${params.name}`,
  }),
  describe: (params) =>
    `Would delete my-resource "${params.name}". This is irreversible.`,
  // Optional: for delete operations, pre-fetch current state
  prefetch: async (params, client) => {
    return await client.get(`/my-resources/${params.name}`);
  },
});
```

Test coverage required for destructive tools:

- Missing `confirm` → returns `confirmation_required` error
- Mismatched `confirm` → returns `confirmation_required` error
- `dry_run: true` without `confirm` → returns preview, no HTTP call
- For deletes: `dry_run: true` → preview includes pre-fetched state
- Correct `confirm` → executes
- `dry_run: true` even with correct `confirm` → still previews

## Adding a new capability tier

1. Add a probe to `packages/core/src/probes.ts` defining the GET request the prober should issue and how to interpret its response codes.
2. Add tier-detection logic in `packages/platform-mcp/src/capabilities.ts`.
3. In `packages/platform-mcp/src/tools/index.ts`, gate the new tier's tool registration on the capability cache.
4. Add unit tests for the probe at `packages/core/test/prober.test.ts` covering 200, 401, 402, 403, 404, 429, and timeout cases.
5. Update [CAPABILITY_PROBES.md](CAPABILITY_PROBES.md) with the new probe.

## Documenting divergences

If you discover that Heroku's actual API behavior differs from what [TOOLS.md](TOOLS.md) says, add a numbered entry to [`notes/divergences.md`](notes/divergences.md). Don't just fix it silently — the divergence log is how we keep TOOLS.md trustworthy over time.

## Pull request workflow

1. Fork the repo and create a feature branch
2. Make your changes, including tests
3. Run the full check sequence: `pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r format:check && pnpm -r test`
4. Add a [changeset](https://github.com/changesets/changesets) describing your change:
   ```bash
   pnpm changeset
   ```
   Select the affected packages and the appropriate semver bump (`patch` for bug fixes, `minor` for new features, `major` for breaking changes — though we don't expect any of these before `1.0.0`).
5. Commit the changeset alongside your code change
6. Open a pull request against `main` with a clear title and description

CI will run typecheck, lint, format-check, test, and build across Node 20 and 22. Integration tests run only on manual workflow_dispatch (they require a maintainer-held Heroku test token).

## Releases

Releases happen at the end of each phase per [the roadmap](README.md#roadmap). Maintainers handle:

1. Running `pnpm changeset version` to apply queued changesets
2. Committing the version bumps and updated changelogs
3. Tagging the release (`core-vX.Y.Z`, `platform-vX.Y.Z`)
4. Pushing tag to trigger npm publish (Phase 10+)

## Code style

- **TypeScript strict mode**, no `any` outside test fixtures
- **Function names are verbs.** Type names are nouns.
- **Prefer composition over inheritance.** The HTTP client is a factory function returning a client object, not a class hierarchy.
- **One concern per file.** `errors.ts` has errors, not errors + utilities + helpers.
- **TSDoc on every exported symbol.**
- **Match what's already there.** When in doubt, mimic the existing patterns in `packages/core/src/`.

Prettier and eslint are authoritative; if they disagree with you, they win.

## Questions

If you're unsure about anything — design decisions, where a feature belongs, whether something is worth doing — open a discussion or draft PR. We'd much rather hear from you early than have you build something we have to ask you to redo.
