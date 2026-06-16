# Naming Convention Update — `heroku-mcp` → `herokumcp`

> Issued mid-Phase-0. Establishes the canonical naming used throughout the project. **Read this before any other doc.** When in doubt, this document overrides any earlier doc.

## TL;DR

| Concept | Use this | NOT this |
|---|---|---|
| Repository directory on disk | `herokumcp` | `heroku-mcp` |
| GitHub repo name | `herokumcp` | `heroku-mcp` |
| Deploy repo names (Phase 5, 8) | `herokumcp-platform-deploy`, `herokumcp-partner-deploy` | `heroku-platform-mcp-deploy`, `heroku-partner-mcp-deploy` |
| npm package scope | `@heroku-mcp/*` (unchanged) | — |
| Individual npm packages | `@heroku-mcp/core`, `@heroku-mcp/platform`, `@heroku-mcp/partner`, `@heroku-mcp/http-server` (unchanged) | — |
| Binary names | `herokumcp-platform`, `herokumcp-partner` (stdio) and `herokumcp-platform-server`, `herokumcp-partner-server` (HTTP) | `heroku-platform-mcp-*` |
| OS keychain service name | `herokumcp` | `heroku-mcp` |
| `$XXX_HOME` config directory env var | `HEROKUMCP_HOME` | `HEROKU_MCP_HOME` |
| All other env vars | `HEROKUMCP_*` | `HEROKU_MCP_*` |
| Config dir on disk | `~/.config/herokumcp` (Linux), `~/Library/Application Support/herokumcp` (macOS), `%APPDATA%\herokumcp` (Windows) | `…/heroku-mcp` |
| MCP connection token prefix | `hmcp_` (unchanged) | — |
| User-Agent header | `herokumcp/<version> (<server-name>)` | `heroku-mcp/<version>` |
| Audit log filenames | `audit-YYYY-MM-DD.log` (unchanged) | — |

## Why the npm package names stay hyphenated

Phase 0 shipped with packages named `@heroku-mcp/core` (visible in your terminal output: `> @heroku-mcp/core@0.0.0 typecheck`). 227 tests pass against this name. Renaming the scope at this point means:

- Editing every `package.json` in the workspace
- Editing every `import` statement that references `@heroku-mcp/*`
- Editing every workspace dependency reference
- Re-running every test
- Risking a subtle change to the lockfile

That's a real day of work for cosmetic gain. The npm-scope convention `@heroku-mcp/*` is also more idiomatic for the npm registry — most scoped packages use hyphens (`@aws-sdk/`, `@types/`, `@modelcontextprotocol/`). Leave the scope alone.

The directory and the user-facing identifiers (env vars, binary names, config dirs) are different — those *are* worth being consistent on, and they're cheap to change because nothing real depends on them yet.

## What needs to change in the existing codebase

Right now, `packages/core` is built and the only consumer is Phase 0's own test suite. The user-facing-identifier changes have small but real impact:

### 1. The keychain service name

In `packages/core/src/tokens.ts`, the `KeychainTokenStore` likely uses `"heroku-mcp"` as the `keytar` service argument. Change to `"herokumcp"`.

**Why now:** every token stored under the old service name will be invisible after the rename. If anyone has already stored a token via the keychain backend (probably no one has, since Phase 0 only tested with mocks), they'll need to re-store it.

### 2. The config directory env var

In `packages/core/src/` wherever the home directory is resolved (probably `tokens.ts`, `audit.ts`, and possibly a shared `paths.ts`):

- Rename `HEROKU_MCP_HOME` → `HEROKUMCP_HOME`
- Rename default path from `…/heroku-mcp` to `…/herokumcp`
- Rename `HEROKU_MCP_LOG_LEVEL` → `HEROKUMCP_LOG_LEVEL`
- Rename `HEROKU_MCP_LOG_FILE` → `HEROKUMCP_LOG_FILE`
- Rename `HEROKU_MCP_PASSPHRASE` → `HEROKUMCP_PASSPHRASE`
- Rename `HEROKU_MCP_TEST_TOKEN` → `HEROKUMCP_TEST_TOKEN` (and any other `HEROKU_MCP_TEST_*` vars)
- Rename `HEROKU_MCP_TOKEN` (the stdio runtime token env var, used for Claude Desktop config) → `HEROKUMCP_TOKEN`

### 3. The User-Agent header

In `packages/core/src/client.ts`, the User-Agent string is built as `"heroku-mcp/<version>"`. Change to `"herokumcp/<version>"`.

### 4. Tests that reference any of the above

Every place above has a corresponding test. Search for the string in `packages/core/test/` and update. The test should *fail* with the old name and pass with the new one — that's how you know the rename actually took.

### 5. Comments and docstrings

Any TSDoc, README sentence, or inline comment that mentions `heroku-mcp` in the context of a directory or env var name needs updating. Don't update mentions of `@heroku-mcp/*` package names — those stay.

## Concrete Claude Code prompt to do this rename

Paste this into the same Phase 0 session (or a fresh one) **before** the lint cleanup and **before** Phase 1:

---

```
The project's canonical name is `herokumcp` (no hyphen), not `heroku-mcp`. The npm package scope `@heroku-mcp/*` STAYS — those package names are fine and renaming the scope would force a large mechanical change across the workspace for no real gain.

What changes are user-facing identifiers only:

  Env vars:
    HEROKU_MCP_HOME       → HEROKUMCP_HOME
    HEROKU_MCP_LOG_LEVEL  → HEROKUMCP_LOG_LEVEL
    HEROKU_MCP_LOG_FILE   → HEROKUMCP_LOG_FILE
    HEROKU_MCP_PASSPHRASE → HEROKUMCP_PASSPHRASE
    HEROKU_MCP_TOKEN      → HEROKUMCP_TOKEN
    HEROKU_MCP_TEST_*     → HEROKUMCP_TEST_*
    (Search for any other HEROKU_MCP_* and rename it. None should remain.)

  Default config directory: ~/.config/heroku-mcp → ~/.config/herokumcp
    (and the macOS/Windows equivalents)

  Keychain service name in KeychainTokenStore: "heroku-mcp" → "herokumcp"

  User-Agent header in the HTTP client: "heroku-mcp/..." → "herokumcp/..."

  Comments and docstrings that reference any of the above by name.

What does NOT change:

  - Any package name under @heroku-mcp/ scope. Leave package.json names alone.
  - Any import statement referencing @heroku-mcp/*.
  - The connection token prefix `hmcp_`.
  - Audit log filename format.
  - Anything else not explicitly listed above.

Process:

  1. grep -rE "HEROKU_MCP|heroku-mcp" packages/ --include="*.ts" --include="*.md" --include="*.json" to find every occurrence.
  2. For each hit, decide: rename (user-facing identifier) or leave (package name / import / unrelated). The list above is the ground truth.
  3. Update src/ first, then test/ to match. Tests should pass after the renames — they were checking the OLD names, so the test updates are part of the rename, not a regression.
  4. Run `pnpm -r typecheck && pnpm -r test && pnpm -r build`. All green.
  5. Report what was changed and how many references were updated per category.

Do NOT touch the eslint setup, the integration test gap, or anything else. This is a focused rename task.
```

---

## What needs to change in the design docs

The handoff docs still say `heroku-mcp` in many places. Rather than retroactively patching seven docs, I'll list the corrections here as the canonical override. **If a previous doc says `heroku-mcp` somewhere and this doc says `herokumcp`, this doc wins.**

### Specific doc-by-doc corrections

**ARCHITECTURE.md:**
- Repo layout tree (line 52): `heroku-mcp/` → `herokumcp/`
- §6 keychain service name: `"heroku-mcp"` → `"herokumcp"`
- §6 `HEROKU_MCP_PASSPHRASE` → `HEROKUMCP_PASSPHRASE`
- §7 User-Agent: `heroku-mcp/<version>` → `herokumcp/<version>`
- §7 audit log path: `$HEROKU_MCP_HOME/audit-...` → `$HEROKUMCP_HOME/audit-...`
- §10 audit log path: same
- §13 log env vars: `HEROKU_MCP_LOG_LEVEL` / `HEROKU_MCP_LOG_FILE` → `HEROKUMCP_LOG_LEVEL` / `HEROKUMCP_LOG_FILE`
- §14 config: `HEROKU_MCP_HOME` → `HEROKUMCP_HOME`; default path `…/heroku-mcp` → `…/herokumcp`; env var prefix references `HEROKU_MCP_*` → `HEROKUMCP_*`
- §5.3 probe cache path: `$HEROKU_MCP_HOME/...` → `$HEROKUMCP_HOME/...`

**ARCHITECTURE.patch.md:**
- Patch 4 repo layout tree (line 67): `heroku-mcp/` → `herokumcp/`
- Patch 4 deploy repo names: `heroku-platform-mcp-deploy` → `herokumcp-platform-deploy`, `heroku-partner-mcp-deploy` → `herokumcp-partner-deploy`
- Patch 6 keychain service name: `"heroku-mcp"` → `"herokumcp"`
- Patch 6 file paths: `$HEROKU_MCP_HOME/tokens.enc` → `$HEROKUMCP_HOME/tokens.enc`
- Patch 6 env var: `HEROKU_MCP_PASSPHRASE` → `HEROKUMCP_PASSPHRASE`
- Patch 7 phase table "Repo" column: every `heroku-mcp` → `herokumcp`
- Patch 7 deploy repo names: same as Patch 4

**CAPABILITY_PROBES.md:**
- Probe cache path: `$HEROKU_MCP_HOME/...` → `$HEROKUMCP_HOME/...`
- Integration test env var: `HEROKU_MCP_TEST_TOKEN` → `HEROKUMCP_TEST_TOKEN`

**DEPLOYMENT.md:**
- Example Heroku app names (`my-team-heroku-mcp`) are example values, not project naming — these can stay as illustrative examples, but if you prefer consistency change to `my-team-herokumcp` throughout. (Recommend: update for consistency since users will mimic the example.)
- Logo URL filename `heroku-mcp-logo.svg` — illustrative, no change required.
- Website URL `your-org.example.com/heroku-mcp` — illustrative, no change required.
- npm package references `@heroku-mcp/platform` — unchanged (npm scope stays).

**HANDOFF.md:**
- Setup instruction directory tree: `heroku-mcp/` → `herokumcp/`
- Env vars in setup section: `HEROKU_MCP_TEST_*` → `HEROKUMCP_TEST_*`
- Phase 1 prompt env var reference: `HEROKU_MCP_TEST_TOKEN` → `HEROKUMCP_TEST_TOKEN`
- Package names in Phase 1 prompt: `@heroku-mcp/core` etc. — unchanged.

**AUTH.md:**
- `@heroku-mcp/core/redact` reference (line 318) — unchanged (npm package).

**TOOLS.md:**
- No `heroku-mcp` references that need updating.

**TRADEMARKS.md:**
- No `heroku-mcp` references that need updating.

## Quick verification after the rename

Once Claude Code finishes the codebase rename, this command should return no hits:

```bash
grep -rE "HEROKU_MCP_|heroku-mcp" packages/ \
  --include="*.ts" --include="*.md" --include="*.json" \
  | grep -v "@heroku-mcp/"
```

(The `grep -v "@heroku-mcp/"` excludes the legitimate npm scope references.)

If that command returns hits, they're either real misses or intentional keeps — review each and decide.

## Sequencing — what to do in what order

1. **Now:** run the rename prompt above against the codebase. This is a focused refactor; 10-15 minutes of Claude Code time.
2. **Verify the rename worked:** run the grep above; run `pnpm -r typecheck && pnpm -r test && pnpm -r build`.
3. **Then the lint setup** (from my earlier guidance — separate task).
4. **Then the integration smoke test** (still missing).
5. **Then commit + changeset + tag** `core-v0.1.0`.
6. **Then Phase 1** in a fresh Claude Code session.

The rename goes first because everything else (lint config, integration test, Phase 1 code) will reference these env vars and identifiers. Fixing them after lint and tests are wired is more churn than doing it now while only Phase 0 exists.
