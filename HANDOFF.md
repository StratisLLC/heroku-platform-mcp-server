# Heroku MCP — Handoff to Claude Code

> Read this if you're the human doing the handoff. The next section is the prompt to paste into Claude Code.

## Before you start Claude Code

1. **Create an empty directory and drop these files in:**
   ```
   heroku-mcp/
   ├── ARCHITECTURE.md
   ├── CAPABILITY_PROBES.md
   ├── TOOLS.md
   ├── HANDOFF.md          ← this file
   ├── LICENSE             ← Apache-2.0
   └── TRADEMARKS.md
   ```

2. **Make sure you have:**
   - Node.js ≥ 20 (`node -v`)
   - pnpm 9.x (`npm install -g pnpm@9` if needed)
   - A Heroku account with a personal API token (`heroku authorizations:create -d "MCP development"`)
   - Ideally: a Heroku Team and at least one app in it
   - Optionally: access to an Enterprise account (otherwise the enterprise tier is untestable)
   - For later: an add-on listing in the Partner Portal with a `client_secret`

3. **Set env vars in your shell (do NOT commit these):**
   ```bash
   export HEROKU_MCP_TEST_TOKEN="HRKU-..."           # for integration tests
   export HEROKU_MCP_TEST_TEAM="your-team-name"      # optional
   export HEROKU_MCP_TEST_APP="your-test-app"        # optional, a disposable app
   ```

4. **Open the directory in your IDE** (VS Code or JetBrains) and **start the Claude Code extension**. Make sure it has access to the workspace.

## The prompt to paste into Claude Code

Copy everything between the lines below into a fresh Claude Code session.

---

```
You are building a TypeScript monorepo: two MCP servers (heroku-platform-mcp and heroku-partner-mcp) backed by a shared core library, exposing Heroku's Platform API and Platform API for Partners as Model Context Protocol tools.

Authoritative design documents are already in the workspace root. Read them in this order before doing anything else:

  1. ARCHITECTURE.md      — overall design, repo layout, lifecycle, security, phases
  2. CAPABILITY_PROBES.md — the runtime probe matrix that gates tool exposure
  3. TOOLS.md             — every tool, its parameters, and the endpoint it wraps

These documents are the source of truth. If something in them is ambiguous or contradictory, STOP and ask before guessing.

Constraints:

- License: Apache-2.0. The LICENSE file is in the root; do not change it.
- Language: TypeScript 5.x, strict mode, ESM.
- Runtime: Node ≥ 20 (use native fetch; do not add node-fetch or axios).
- Package manager: pnpm 9.x with workspaces.
- Test runner: vitest.
- Lint/format: eslint + @typescript-eslint, prettier.
- Build: tsup per package, ESM output with types and source maps.
- Release: changesets, independent versioning per package.
- CI: GitHub Actions — typecheck, lint, test on Node 20 and 22.

Layout: exactly the structure shown in ARCHITECTURE.md §4. Three packages: @heroku-mcp/core, @heroku-mcp/platform, @heroku-mcp/partner.

Approach — work in phases as defined in ARCHITECTURE.md §15. Do NOT try to implement everything at once.

For THIS first session:

  Phase 0 — packages/core only. Implement, in order:
    1. Project bootstrap: pnpm-workspace.yaml, package.json files, tsconfig.base.json, eslint and prettier configs, vitest config, a minimal CI workflow. Verify `pnpm install` and `pnpm -r typecheck` pass.
    2. core/src/errors.ts — typed error hierarchy per ARCHITECTURE.md §8.5 and §12. Unit tests.
    3. core/src/redact.ts — secret redaction per §9. Unit tests covering every redaction rule with adversarial inputs.
    4. core/src/ratelimit.ts — RateLimit-Remaining tracker with the serial-queue threshold per §7. Unit tests.
    5. core/src/etag.ts — ETag cache with 304 handling. Unit tests.
    6. core/src/pagination.ts — Content-Range / Next-Range helpers. Unit tests.
    7. core/src/audit.ts — JSONL audit logger with daily rotation per §10. Unit tests using a tmpdir.
    8. core/src/tokens.ts — token storage interface plus three implementations: keychain (keytar), encrypted file (AES-256-GCM, scrypt KDF), in-memory. Unit tests for each.
    9. core/src/client.ts — the HTTP client tying everything together per §7. Mock fetch in tests; do not call real Heroku.
    10. core/src/schema.ts — fetches /schema, parses, caches by ETag. Unit tests against a captured schema fixture committed to test/fixtures/.
    11. core/src/prober.ts — capability prober per CAPABILITY_PROBES.md. The probe matrix is data, not code; put it in core/src/probes.ts as an exported const array. Unit tests against the response-class fixtures described in CAPABILITY_PROBES.md "Test fixtures".

After every file: run typecheck, run tests, fix what breaks. Don't move on with a red bar.

Things to ASK ME about rather than assume:

- Anything not specified in the three design docs.
- Whether to use a specific dependency I haven't listed (e.g. you might want zod for runtime schema validation — that's reasonable but ask).
- Any place where Heroku's actual API behavior contradicts the docs as I've described them.
- Whether to commit captured /schema fixtures or fetch them in a setup step.

Things you should JUST DO:

- Set up CI exactly as specified.
- Use the file layout from §4 exactly.
- Add a TRADEMARKS.md and LICENSE if they aren't there yet (Apache-2.0 boilerplate).
- Add a top-level README.md with the two-MCP overview, license badge, install commands, and a link to ARCHITECTURE.md.
- Add a CHANGELOG.md scaffolded by changesets.
- Write proper TSDoc on every exported symbol.

Style:

- Strict TypeScript. No `any` except in test fixtures. No `// @ts-ignore` unless you also leave a comment explaining why and a TODO.
- Error messages are user-facing — write them like a person will read them, because one will.
- Function names are verbs. Type names are nouns. No Hungarian notation.
- Prefer composition over inheritance. The HTTP client is a function that takes config and returns a client object, not a class hierarchy.
- One concern per file. errors.ts has errors, not errors + utilities + helpers.

When Phase 0 is complete and CI is green, STOP and report back. We'll review before starting Phase 1.

Begin.
```

---

## What to do during the build

- **Don't let it skip tests.** If Claude Code reports "tests pass" but `pnpm test` shows red, push back. Tests are the contract.
- **Watch for hallucinated dependencies.** If you see an import for something exotic, ask "why this instead of stdlib?"
- **Probe the prober.** When Phase 0 ships, hand-craft a test that exercises the prober against a fake server returning 200, 401, 402, 403, 404, 429 for each tier and verify the resulting capability file matches expectations.
- **Don't accept silent failures.** Every catch block should either re-throw or log+propagate a typed error. "Swallowed" exceptions are a bug.
- **Be skeptical of `as any` and `// @ts-expect-error`.** Both are fine in tests, suspicious in src.

## When you hit ambiguity

Two failure modes are common in long agentic coding sessions:

1. **Doc drift.** Claude Code modifies the design docs to match what it built, instead of building what the docs say. Watch for unsolicited edits to `ARCHITECTURE.md`/`CAPABILITY_PROBES.md`/`TOOLS.md`. If the docs need to change, that should be a deliberate decision you make, not a quiet edit.

2. **Scope creep.** Claude Code finishes Phase 0 and rolls into Phase 1 without checking in. Stop it. Each phase has a defined acceptance condition; honor them.

If you hit a design question that needs human judgment, bring it back to the planning chat (where these docs came from). Don't try to resolve it inside the build session — the build session is for building, not designing.

## After Phase 0

When CI is green and Phase 0 is shipped, a sensible Phase 1 prompt is something like:

> Phase 0 is merged. Begin Phase 1 per ARCHITECTURE.md §15: implement packages/platform-mcp end-to-end for the account and apps tiers, read-only. Capability probing must be live. The server must respond correctly to `initialize`, `tools/list`, and `tools/call`. Use the MCP TypeScript SDK (`@modelcontextprotocol/sdk`). Smoke test against my HEROKU_MCP_TEST_TOKEN before declaring done. Stop when both `apps_list` and `apps_info` work end-to-end against a real account.

But don't queue that up until Phase 0 is actually done. Each phase wants to be its own conversation in Claude Code — context resets are good hygiene.

## Heroku test account checklist

For the integration tests to actually exercise the prober and client:

- [ ] Personal API token created (`heroku authorizations:create -d "MCP dev"`)
- [ ] At least one app in your personal account
- [ ] One disposable app you don't mind deleting (for write tests later)
- [ ] If you have access: at least one team
- [ ] If you have access: at least one enterprise account
- [ ] If you have access: at least one space
- [ ] At least one add-on attached to a test app (any free plan — `heroku addons:create heroku-postgresql:essential-0`)

You won't need everything for Phase 0. Phase 0 only needs the token and an account.
