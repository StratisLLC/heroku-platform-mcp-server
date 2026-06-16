# Code Mode — the `/mcp-codemode` endpoint

Code Mode is a token-optimized MCP endpoint, shipped in
`@heroku-mcp/http-server` 1.1.0. It serves the *same* Heroku tool surface as the
standard `/mcp` endpoint, but replaces the up-front transmission of all 276 tool
schemas with three meta-tools the model uses to discover and invoke tools on
demand.

It is **opt-in and non-breaking**: `/mcp` is unchanged. Customers switch by
pointing their connector at `/mcp-codemode` instead of `/mcp`.

## The problem it solves

Standard MCP advertises every tool's full JSON schema via `tools/list` on every
session. For this server that is 276 tools — roughly **60,000 tokens** of schema
transmitted per conversation, whether or not the model uses any given tool.

## How it works

`/mcp-codemode` advertises exactly three tools:

| Tool | Purpose |
|---|---|
| `search` | Substring search over tool name + description. Returns matches with a **Standard-detail** parameter list: each parameter's `name`, `type`, and `required` flag — no parameter descriptions, no nested JSON schema. |
| `execute` | Invoke a tool by name with an `args` object. Dispatches through the same audit-wrapped, capability-gated, confirm-guarded handler a direct `/mcp` call hits. |
| `auth_status` | The session's identity and access scope: `email`, `scopes` (the capability tiers the probe pass authorized), `teams` (live `GET /teams`), and `orgs` (live `GET /enterprise-accounts`). |

The model calls `search` to find the few tools a task needs, then `execute` to
run them. Only the schemas of tools actually touched enter the context window.

### Discovery, not a new execution path

`execute(name, args)` is functionally identical to invoking `name(args)` over
standard MCP. The full tool catalog is still built server-side per session
(gated by the same capability probes as `/mcp`); Code Mode validates the args
against the tool's schema and calls the same registered handler. That means:

- **Audit** — the underlying tool's audit row is written with the real tool name
  and arguments, exactly as a direct call. No extra "execute" row.
- **Confirmation guards** — destructive tools still require their `confirm`
  value; `dry_run` still works. These live in the tool's input schema and
  handler, both of which `execute` goes through.
- **Capability gating** — a tool the user's token can't access is never
  registered, so it never appears in `search` and `execute` reports it unknown.

## Token savings

Measured by the on-demand benchmark
(`CODEMODE_BENCH=1 pnpm --filter @heroku-mcp/http-server test -- codemode-tokens`),
which boots the full 276-tool catalog and compares the real `tools/list` wire
payloads (token counts are a transparent char/4 approximation — no tokenizer or
ML dependency):

| Measurement | Tokens | Reduction |
|---|---|---|
| `/mcp` `tools/list` (276 tools, full schemas) | ~60,800 | baseline |
| `/mcp-codemode` `tools/list` (3 meta-tools) | ~585 | **99.0%** |
| `/mcp-codemode` end-to-end (3 meta-tools + a 7-query discovery sequence) | ~7,900 | **87.0%** |

The headline claim quoted in marketing — *~85% reduction in tool-schema
transmission per conversation* — is the conservative end-to-end figure. The
`tools/list`-only reduction (the fixed per-conversation overhead) is ~99%; the
end-to-end number depends on how many tools a given conversation discovers.

## When to use which

- **`/mcp`** — best for clients that pre-load and cache tool schemas, or when
  you want the model to see the entire catalog at once. Most current MCP clients.
- **`/mcp-codemode`** — best when running many conversations against the same
  server and you want to minimize per-conversation token overhead. The model
  needs to be comfortable with a search-then-execute workflow; the meta-tool
  descriptions instruct it explicitly.

## Switching a connector

1. Edit the connector.
2. Change the URL suffix from `…/mcp` to `…/mcp-codemode`.
3. Reconnect — the OAuth flow runs once more (one-time).

After switching, the model sees three tools instead of 276. Functionality is
identical; only the discovery surface changes.

## Design notes

- **Substring search only.** No embeddings, vectors, or ML dependencies (an
  architectural rule for this project). Ranking is deterministic: exact name >
  name-prefix > name-substring > description-substring.
- **Static per-session index.** The catalog is built once at session creation
  from the session's authorized tools and never changes for the session's
  lifetime — the tool registry doesn't change at runtime.
- **Two servers per session.** The full catalog server (all tools, audit-wrapped)
  is built but kept off-transport as the `execute` dispatch target; a separate
  3-tool meta server is what the transport speaks to.
