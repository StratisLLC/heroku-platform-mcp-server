# Token Optimization for Heroku MCP — Full Landscape, Updated June 2026

## Found the Anush reference

You'd told me about this on **May 27, 2026** while we were finishing Phase 3. The full conversation is in `/mnt/transcripts/2026-05-27-17-01-19-herokumcp-phases-0-4.txt`, lines 1294-1399.

The reference: **Anush D'Souza's `dsouzaAnush/heroku-code-mcp`** — a compact MCP server for the Heroku Platform API using a Code Mode pattern with three tools: `search` + `execute` + `auth_status`. His published benchmarks vs the official Heroku MCP:

| Metric | heroku-code-mcp | Official Heroku MCP | Delta |
|---|---|---|---|
| Tool count | 3 | 37 | 91.9% lower |
| Tool-list payload bytes | 1,469 | 25,500 | **94.2% lower** |
| Tool-list approx tokens | **368** | 6,375 | 94.2% lower |
| Connect avg | 14.8 ms | 10,168.7 ms | 687x faster |
| Read op avg | 528 ms | 9,697 ms | 18.4x faster |

That's **368 tokens for the entire control surface vs 6,375 for the official 37-tool version**, with no accuracy loss. Benchmarks captured February 22, 2026.

You also linked:
- **Cloudflare Code Mode**: https://blog.cloudflare.com/code-mode-mcp/
- **Anthropic Progressive Disclosure for Skills**: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#progressive-disclosure-patterns

At the time we measured **our own Heroku MCP at 152 tools = 206,414 chars = ~55,000 tokens** per turn. The decision back then was to defer this to "Phase 9.5" right before 1.0, so we wouldn't rebuild it as each tier landed. We're now at ~241 tools post-Phase 5 with Phase 6 starting, so the question is whether to keep deferring or pull it forward.

---

## What's changed since May 27

Quite a lot, actually. The landscape moved fast.

### New: Anthropic published their own Code Mode pattern (November 4, 2025)

**Anthropic's official guidance**: "Code execution with MCP" — same idea as Cloudflare but documented as a native Anthropic-recommended pattern. The published benchmark in the post: **150,000 tokens → 2,000 tokens for the same task (98.7% reduction)**.

Key new ideas in Anthropic's version beyond Cloudflare's:
- Tools as **files in a filesystem** rather than two meta-tools. Agent navigates `./servers/google-drive/getDocument.ts` and reads only the files it needs. Maps naturally to how Claude already navigates filesystems.
- **Privacy-preserving tokenization** — sensitive data (emails, PII) gets replaced with `[EMAIL_1]` etc. before reaching the model, untokenized on its way back out via the MCP client.
- **Skills integration** — saved code becomes reusable skills with `SKILL.md` files. Builds a long-term capability library.

Source: https://www.anthropic.com/engineering/code-execution-with-mcp

### New: Anthropic's native `defer_loading` API (November 2025, `mcp-client-2025-11-20` beta)

A different mechanism from Code Mode. Doesn't require code execution infrastructure at all. You mark tools `defer_loading: true` in the API request, and Anthropic provides built-in `tool_search_tool_regex_20251119` or `tool_search_tool_bm25_20251119` to discover them at runtime.

```json
{
  "tools": [
    {"type": "tool_search_tool_regex_20251119", "name": "tool_search_tool_regex"},
    {"name": "github.createPullRequest", "defer_loading": true, ...},
    // hundreds more deferred tools
  ]
}
```

Anthropic's own benchmark: **Tool Search preserves 191,300 tokens of context** vs 122,800 with the traditional approach. Bigger wins than I'd previously cited.

Also: accuracy *improves*. Opus 4 went from 49% → 74%, Opus 4.5 from 79.5% → 88.1% on internal MCP evals. Smaller catalogs reduce decision paralysis.

This pattern is **easier to adopt than Code Mode** — no sandbox, no filesystem, no code execution infrastructure. Just an API-level flag.

### New: Bifrost benchmark (April 2026) — Code Mode dominates at scale

Published findings on Code Mode vs traditional MCP at 100, 250, and 500 tools:
- At 100 tools: meaningful but moderate win for Code Mode
- At 250 tools: gap widens sharply
- **At 500 tools: ~14× fewer input tokens per query, ~13× total cost reduction**
- Pass rate stayed at 100% across all rounds

The key insight: **classic MCP cost scales with tool count; Code Mode cost scales with what the model actually reads.** Above ~250 tools, you're in different economic universes.

### New: FastMCP 3.1 added Code Mode as a first-class library feature (March 2026)

If you're using FastMCP (Python or TypeScript), Code Mode is now a built-in transform. Tools: `Search`, `GetTags`, `GetSchemas`, `ListTools`. Server author picks which to enable, agents progressively narrow down.

### New: Dodo Payments shipped Code Mode for their MCP (March 2026)

Real-world case study from a payments company. Went from "55K to 100K+ tokens" of tool definitions to ~1,000 tokens. **95%+ reduction in context overhead** on their production MCP.

### New: Cloudflare + Anthropic deep integration (May 2026)

Claude Managed Agents now run on Cloudflare Sandboxes. Anthropic frames it as "decoupling the brain from the hands" — agent loop on Anthropic, code execution on Cloudflare microVMs. If you go Code Mode, this is the production-grade hosting story.

### What I missed in my previous memo

Two important things I should have flagged but didn't:

1. **Code Mode and `defer_loading` are different mechanisms with different costs.** I conflated them. Code Mode is the bigger win but the bigger lift. `defer_loading` is a smaller win but trivial to adopt.

2. **The accuracy data on `defer_loading` matters as much as the token data.** A 49% → 74% accuracy improvement on Opus 4 isn't trivial; for our use case it's the difference between "tool works" and "tool doesn't." With 241 tools, we're probably eating an accuracy penalty we don't see because we're not measuring against a no-deferral baseline.

---

## Updated landscape: every approach on the table, ranked by cost-benefit

### Tier 0 — Free wins to do immediately (already in my last memo, still true)

1. **Description discipline** — every tool description tightened, examples moved to separate skills/resources
2. **Shared schema deduplication** — `app_id_or_name`, `confirm`, `dry_run` defined once, referenced everywhere
3. **Prompt caching for tool definitions** — already supported by Anthropic API, ensure we're using it

**Impact:** 15-25% token reduction. **Effort:** Days. **Decision needed:** None — do it.

### Tier 1 — `defer_loading` (Anthropic's native API feature)

The easiest progressive disclosure path. Mark all but the most-used 5-10 tools as `defer_loading: true`, add `tool_search_tool_bm25_20251119` to the tools array, done.

**Impact:**
- Token reduction: 70-85% (Anthropic's published numbers)
- Accuracy gain: 25 percentage points on Opus 4, 8.6 on Opus 4.5
- Tokens preserved: ~191K vs ~123K traditional

**Effort:** Days, not weeks. The MCP server adds `defer_loading: true` to tool definitions, the client (Claude Desktop) handles the rest via the beta header. Custom Connector path may not yet honor the beta — would need to verify.

**Risk:**
- It's still beta (`mcp-client-2025-11-20` header)
- Custom Connectors in Claude Desktop may or may not pass the beta header
- Agent has to write reasonable search queries (failure mode on smaller models)

**Heroku-MCP fit:** Strongest single intervention. Easy to ship, big gain, accuracy bonus.

### Tier 2 — Code Mode (Cloudflare / Anush / Anthropic pattern)

Replace the entire tool catalog with 2-3 meta-tools: `search`, `execute`, `auth_status`. Agent writes code (or structured calls) that the server validates and executes.

Two flavors:

**Tier 2a — Anush's pattern (simplest)**
Three tools: `search(query)`, `execute(operation_id, params)`, `auth_status()`. Schema discovery from OpenAPI specs. Anush already proved this works against Heroku specifically. **Most directly applicable to us.**

**Tier 2b — Anthropic's filesystem pattern (more powerful)**
TypeScript files in a sandbox filesystem, agent writes real code that calls them. More flexible (loops, conditionals, filtering, multi-step composition in one execution). Requires a sandboxed execution environment.

**Impact:**
- Token reduction: 94-99% (Anush's measured, Anthropic's published)
- Tools-list payload: 368 tokens vs 25,500 (Anush vs official Heroku MCP)
- At 500+ tools (where we're heading): 13-14x cost reduction

**Effort:**
- Tier 2a: 2-3 weeks. Anush's repo is open-source ISC-licensed; we could fork or learn from it.
- Tier 2b: 4-6 weeks. Sandboxed code execution is real infrastructure.

**Risk:**
- Tier 2a: Lose tool-by-tool input schema validation at the MCP-protocol level. We'd validate inside `execute`. Anush's repo does this.
- Tier 2b: Code execution security surface. Sandbox correctness is a real engineering problem.
- Both: Model needs to handle a more abstract surface. May be less ergonomic for users who liked seeing individual tools listed in Claude Desktop.

**Heroku-MCP fit:** Excellent long-term. The Heroku API is extremely well-suited (REST, OpenAPI-described, deterministic, finite resources).

### Tier 3 — Hybrid (Tier 0 + 1 + light 2)

The realistic high-value option I think we should consider seriously:

1. Do Tier 0 (description discipline) right away
2. Add Tier 1 (`defer_loading`) for everything except 5-10 high-frequency tools
3. Add a Tier 2a-style `search` + `execute` meta-pair as an alternative path for power users / agents

This gives users the choice. Casual users see a curated 10-tool catalog (the heavy hitters: `apps_list`, `apps_info`, `pg_list`, etc.) with everything else discoverable. Power users / agents that want minimal context use the meta-pair.

**Impact:** Tier 0 + 1 alone gets us to ~90% of the win. The meta-pair adds the remaining 9%.

**Effort:** 2 weeks for Tier 0+1, then 2-3 more for the meta-pair if we want it.

### Tier 4 — Skills-as-replacement

The most aggressive shift, and worth mentioning even though I'd not recommend it: replace MCP entirely with Claude Agent Skills. Folders of TypeScript modules that the agent reads progressively. This is what Anthropic's Code Mode post hints at and what MCPJam predicts will eat MCP's lunch.

**Impact:** Maximum context efficiency. Skills are designed for progressive disclosure from the ground up.

**Effort:** Months. Different distribution model (zip files / plugin marketplace, not MCP servers). Different auth story.

**Risk:** MCP wins on standardization, OAuth, multi-client support. Skills are early. We'd be betting on Anthropic's direction at the expense of openness.

**Heroku-MCP fit:** Not now, but worth watching. If you're building for Claude users specifically, this is the long-term trajectory Anthropic appears to be on.

---

## What I'd actually recommend now

Given how the landscape has matured since May 27:

### Immediate (alongside Phase 6): Tier 0 + Tier 1

Don't wait for Phase 9.5. The reasons to defer that were:
- Avoid rework as tiers land
- Wait until full surface exists to benchmark realistically
- Validate across MCP clients

But all three are weaker arguments now:
- **Tier 0** is description-level housekeeping — does nothing tier-specific
- **Tier 1** (`defer_loading`) is an API-level flag that works regardless of how many tools we add later. Adding tools after Phase 6 just means adding them with `defer_loading: true`. No rework.
- **Anthropic's own evals** validated `defer_loading` across MCP scenarios at scale. We don't need a fully-mature catalog to start.

**Concrete plan: parallel to Phase 6 (Postgres) build, do a Phase 6.5 "context engineering" pass.**

Week-by-week:
- Week 1 (alongside Phase 6 Part A): Tier 0 description audit. Tighten every tool description in `@heroku-mcp/platform-mcp`. Move examples to docs.
- Week 2: Implement `defer_loading: true` in the MCP server's `tools/list` response. Designate 5-10 always-loaded tools (apps_list, apps_info, pg_list, pg_info, releases_list, dynos_list, addons_list, dynos_run, config_vars_get, releases_create).
- Week 3: Add `tool_search_tool_bm25_20251119` declaration alongside our tool list. Test against Claude Desktop Custom Connector to confirm the beta header is honored.
- Week 4: Measure. Token cost before/after. Tool selection accuracy before/after. Document.

### Medium-term (between Phase 6 and Phase 7): Tier 2a (Code Mode)

After Phase 6 Postgres lands and we have a stable feature set, build the Anush-style `search` + `execute` + `auth_status` meta-tool layer. Offer it as an alternative endpoint.

User chooses: connect to `/mcp` for the full catalog (with `defer_loading`), or `/mcp-code` for the minimal three-tool Code Mode interface. Power users / agents pick the lighter surface. Most users won't notice the option exists but those who care will love it.

This becomes a **Phase 7** — replacing what I'd previously called "progressive disclosure / code-mode" with a more concrete implementation now that we know exactly what we're building.

### Long-term (post-1.0): evaluate full Anthropic filesystem pattern

If catalog grows past 400 tools or we see customer-grade scale on the Code Mode endpoint, consider migrating to Anthropic's filesystem-of-TypeScript-modules pattern. Real sandboxed code execution. Larger lift, larger payoff.

---

## What the latest research actually says about size thresholds

Worth knowing the numbers cleanly:

| Tool count | Without optimization | With `defer_loading` | With Code Mode |
|---|---|---|---|
| 50 | ~10-20K tokens | ~3-5K tokens | ~500-1000 tokens |
| 100 | ~25-40K tokens | ~5-8K tokens | ~800-1500 tokens |
| 250 | ~70-100K tokens | ~12-18K tokens | ~1000-2000 tokens |
| 500 | ~150-200K tokens | ~25-35K tokens | ~1000-2000 tokens |

**Where Heroku MCP sits:**
- Today: 241 tools, ~50-55K tokens (measured)
- After Phase 6: 281 tools, ~65K tokens projected
- After Phase 6.5 + 6.6 (Data APIs done): 321 tools, ~75K tokens projected
- At 1.0 (Platform complete): 280-300 tools, ~70K tokens projected
- With Partner MCP added: 330-350 tools, ~85K tokens projected

We're past the "casual" zone where 50+ tools just works. We're squarely in the "real optimization required" zone (>200 tools) but not yet in the "Code Mode is the only sane choice" zone (>500 tools).

That puts us in the sweet spot for the Tier 0 + Tier 1 + optional Tier 2a hybrid. Get most of the win cheaply; the rest is gravy.

---

## One thing I'd flag for decision

**Don't defer this any longer than absolutely necessary.** The previous decision (Phase 9.5) was made when the landscape was less mature. Now we have:

- Anthropic publishing the pattern as a recommended best practice
- Beta API features specifically for this use case
- Open-source reference implementations (Anush's, FastMCP's, Dodo Payments')
- Real benchmarks showing accuracy improvements alongside token savings

The argument to keep waiting was "don't optimize prematurely." That was right then. It's getting weaker. Phase 6 adds 40 tools without optimization; Phase 6.5 + 6.6 adds another 80. Every phase makes the optimization win bigger but the cleanup work no harder.

**My direct recommendation:** Do Tier 0 + Tier 1 starting now, alongside Phase 6. Don't wait.

---

## Open questions for you

1. **Does Claude Desktop Custom Connector pass the `mcp-client-2025-11-20` beta header?** If not, our `defer_loading` work won't take effect for our actual primary users (Claude Desktop). Worth a quick test before committing to Tier 1.

2. **Are we OK shipping `defer_loading: true` on tools while still in beta?** Anthropic could change the API. Mitigation: easy to revert (just remove the flag from `tools/list` response). Low real risk.

3. **What's the cost story?** All this token math matters mainly because of context window and cost. For your typical user, hitting prompt caching, the per-conversation cost difference between 55K and 5K tool tokens might be small. Worth checking what the actual customer cost looks like before deciding the priority.

4. **The relationship to Phase 7 (progressive disclosure / code-mode) in the existing roadmap.** If we do Tier 1 now, the old Phase 7 becomes "do Code Mode (Tier 2a) as a parallel endpoint." Cleaner naming. Worth updating the roadmap doc accordingly.
