# Sample Prompt 3 — Six-Month Usage Analysis & Optimization Report

**Difficulty:** Advanced · **Scope required:** ⚠️ `global` **+ billing/enterprise-admin permission** · **Works for:** Account owners & billing admins

This is the showcase — a full usage analysis across six months, turned into a
downloadable report with charts, raw-data tables, observations, and
documentation-grounded optimization suggestions. It exercises the deepest part of the
platform surface and produces something you'd actually hand to a stakeholder.

It starts by asking **which enterprise org** to analyze — so if you administer several
companies, you run the report on exactly one, never all of them at once.

### ⚠️ Read this first — it has a prerequisite

Heroku usage and billing data is gated **twice**:

1. The MCP must have been deployed (or reconfigured) with **`global`** OAuth scope —
   not the default `identity,write-protected`. (At deploy time, type `global` in the
   `HEROKUMCP_OAUTH_SCOPE` field.)
2. **Your own Heroku user must hold billing or enterprise-admin permission** on the
   enterprise org you're analyzing. The `global` scope alone is not enough — if your
   user lacks billing rights, Heroku itself will refuse the data.

If either gate isn't met, the agent will hit a clean "access not allowed" on the usage
calls. That's expected — usage data is sensitive and Heroku guards it tightly. If you're
on the default scope, **Sample Prompts 1 and 2 are the ones for you**; this one is for
account owners and admins.

---

## The prompt

> I want a **six-month Heroku usage and cost-optimization report** for one of my
> enterprise organizations, produced as a downloadable file I can share. Work through
> this carefully.
>
> **Step 0 — Scope and confirm access.** First check who I am, then list the enterprise
> organizations I have access to. Show me that list and ask me which **one** to run the
> report on. Wait for my answer — do not analyze all of them. Once I've picked an org,
> capture its **account/enterprise identifier (UUID)** — you'll need the UUID, not the
> name, for the usage calls. Then confirm whether I have the billing/usage access this
> report needs for that org. If I don't, stop and tell me plainly which gate I'm missing
> (scope vs. billing permission) rather than guessing.
>
> **Step 1 — Gather the data.** For the chosen enterprise org (using its UUID), pull
> **monthly** usage for the last six full months. Break it down by the dimensions the
> usage API exposes — by app, by add-on/resource type, and by the usage units Heroku
> reports (e.g. dyno units, data/add-on costs). Where daily granularity is available and
> useful for the most recent month, pull that too so we can see intra-month trend. Use
> the correct date formats Heroku requires (monthly = YYYY-MM, daily = YYYY-MM-DD) and
> pass the account **UUID**, not a name.
>
> **Step 2 — Build the report.** Produce a single, well-designed **downloadable report
> file** containing:
>
> - **Executive summary** — total spend/usage over six months, month-over-month trend,
>   the headline number a CFO would want.
> - **Charts** — at minimum: a six-month trend line of total usage; a breakdown of usage
>   by app (top contributors); a breakdown by resource/add-on type. Make them clean and
>   labeled.
> - **Raw data tables** — the underlying monthly figures per app and per resource type,
>   so the numbers behind the charts are auditable.
> - **Observations** — what the data actually shows: which apps dominate cost, what's
>   trending up or down, any month with an anomalous spike, anything scaled but idle, any
>   add-on that looks oversized for its app.
> - **Suggestions for usage enhancement** — concrete, prioritized optimization
>   recommendations. Ground these in **official Heroku guidance** on dyno sizing, formation,
>   add-on plan selection, and cost management. For each suggestion, say what to change,
>   the expected impact, and the trade-off. Cite the Heroku documentation you're drawing on.
>
> **Step 3 — Deliver.** Give me the report as a file I can download and share, and a short
> spoken summary of the top three takeaways.
>
> Narrate what you're pulling as you go. If any usage call is denied, tell me exactly which
> one and why, and continue with whatever data I *can* access rather than failing the whole
> report.

---

## What this demonstrates

- **Scoped, intentional access** — you choose exactly one org; the report never sweeps
  across every company you administer.
- **The full depth of the platform surface** — usage/billing is the most privileged,
  most valuable data the MCP can reach.
- **Correct API discipline** — per-endpoint date formats, account UUID vs. name, the
  exact details that make real billing integrations work (and that this MCP handles for you).
- **Documentation-grounded reasoning** — suggestions aren't invented; they're tied to
  Heroku's own published guidance, with citations.
- **A real deliverable** — a shareable report, not just an answer in a chat window.
- **Graceful degradation** — if some data is gated, the agent tells you precisely what
  and keeps going, instead of collapsing.

## Tips

- If Step 0 says you're missing access: to enable usage data you'll need to redeploy /
  reconfigure the MCP with `global` scope **and** confirm your Heroku user has billing or
  enterprise-admin rights. See the OAuth setup notes in the repo.
- Once you have a report, try: *"Now model what my spend would look like if I applied your
  top three suggestions."* — the agent will reason about the projected impact.
- Best experienced in a client that can create files (like Claude), where the downloadable
  charted report renders in full. In a barebones MCP client without file tools, the agent
  will fall back to inline tables.
