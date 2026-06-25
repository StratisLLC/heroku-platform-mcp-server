# Sample Prompt 2 — Release & Health Investigation

**Difficulty:** Intermediate · **Scope required:** Default (`identity,write-protected`) · **Works for:** Everyone

This one shows the MCP's *agentic depth* — not a single lookup, but a chain of
reasoning where each finding drives the next call. You give the agent a goal and it
runs the investigation, the way a platform engineer would when asked "is this app
healthy and what changed recently?" Still entirely read-only and default-scope-safe.

It starts by asking **which enterprise org** to work within, then helps you pick the
app to investigate — so you're never guessing app names or sweeping across orgs you
didn't mean to.

---

## The prompt

> I want a health and recent-change review of one app, investigated the way an on-call
> engineer would.
>
> **First, scope it.** Confirm who I am and list the enterprise organizations I have
> access to. Ask me which **one** to work within, and wait for my answer. Once I've
> picked an org, show me the apps under it that look like production (skip obvious
> scratch/test apps) and ask me which app to investigate — or let me name one directly.
> Don't start the investigation until I've chosen the app.
>
> **Then investigate that app, following the evidence:**
>
> 1. **Current state.** Pull the app's info, its dyno formation, and its running dynos.
>    Is what's *running* consistent with the configured formation? Flag any drift
>    (crashed dynos, process types scaled differently than expected).
>
> 2. **What changed.** Walk the recent release history. For the latest few releases,
>    tell me what each one was (deploy, config change, add-on change, rollback) and when.
>    Identify the most recent change that could plausibly affect behavior.
>
> 3. **Configuration sanity.** Review the config var *keys* present (you don't need the
>    secret values). Flag anything that looks risky or incomplete: missing-looking
>    required vars, debug flags that might be on in production, that kind of thing.
>
> 4. **Dependencies.** List the add-ons and, for any Postgres database, its plan, status,
>    and whether it has followers. Note anything near a plan limit or in a non-healthy
>    state.
>
> 5. **Verdict.** Pull it together: is this app in a healthy, expected state? What's the
>    single most recent thing that changed? What are the top 2–3 things you'd watch or
>    investigate further? Be specific and cite which tool calls told you what.
>
> Narrate your investigation as you go so I can follow your reasoning, then give me the
> verdict at the end.

---

## What this demonstrates

- **Scoped, intentional access** — you pick the org and the app; the agent doesn't roam.
- **Multi-step agentic reasoning** — each step's results inform the next; the agent
  isn't just dumping data, it's drawing conclusions and chasing them.
- **Cross-tool correlation** — formation vs. running dynos, releases vs. config, add-on
  state vs. health, the kind of synthesis that's tedious by hand.
- **Operational judgment** — the agent applies "what would I flag to a teammate"
  reasoning, not just retrieval.
- **Still 100% read-only** — diagnosis without touching anything.

## Tips

- Great follow-ups: *"Show me exactly what changed in the last release"* or *"If you
  were going to roll this back, which release would you target and why?"* (it will
  reason about the target without actually rolling back unless you explicitly confirm).
- The destructive tools (restart, scale, rollback) all require an explicit confirmation
  step — so even if you ask the agent to *act* on its findings, it can't change anything
  without you deliberately authorizing it.
