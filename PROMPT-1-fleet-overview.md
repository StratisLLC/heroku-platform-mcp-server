# Sample Prompt 1 — Fleet Overview

**Difficulty:** Beginner · **Scope required:** Default (`identity,write-protected`) · **Works for:** Everyone

Your first paste. This one works no matter how you deployed — no elevated scope, no
billing permissions, no setup beyond connecting the MCP. It gives the agent a reason
to fan out across one Heroku enterprise org and come back with a structured picture,
so you immediately see the breadth of what the server can reach.

It starts by asking **which enterprise org** to look at — so if you have access to
several, you choose one rather than sweeping across all of them.

---

## The prompt

> I want a complete inventory of one of my Heroku enterprise organizations.
>
> **First, scope it.** Confirm who I am, then list the enterprise organizations I have
> access to. Show me that list and ask me which **one** to run this inventory on. Wait
> for my answer — do not proceed across all of them. (If I only have access to one,
> name it and confirm before continuing. If I tell you to use a specific org by name,
> match it to its identifier and confirm you've got the right one.)
>
> **Then, once I've picked an org**, walk through every app under that organization's
> teams. For each app, gather: its region and stack, the current dyno formation (process
> types, sizes, quantities), the add-ons attached, and the most recent release with its
> version and date. Where an app has a Postgres database, note its plan and status.
>
> Then synthesize all of it into a single overview for that org:
>
> 1. **Summary table** — one row per app: name, owning team, region, stack, dyno count,
>    add-on count, latest release date.
> 2. **Footprint at a glance** — totals: how many teams and apps, how many running dynos
>    across everything, which regions, which add-on services I use most.
> 3. **Notable observations** — anything that stands out: apps with no recent releases,
>    apps scaled to zero, single-dyno apps that might be production, mismatched stacks,
>    or anything you'd flag to a colleague doing a quick portfolio review.
>
> Work through the apps methodically and tell me what you're finding as you go. If the
> org has a lot of apps, prioritize the ones that look like production over scratch/test apps.

---

## What this demonstrates

- **Scoped, intentional access** — the agent enumerates your orgs and lets you choose,
  rather than blindly sweeping everything you can reach.
- **Identity & access discovery** — it grounds itself with `auth_status` before acting,
  so you see exactly what your connection can reach.
- **Breadth of the platform surface** — apps, formations, add-ons, releases, Postgres,
  all stitched into one view from many underlying tools.
- **Read-only and safe** — every call here is a read. Nothing is created, scaled, or
  destroyed. A perfect no-risk first run.

## Tips

- If you have many apps in the chosen org, the agent may take a minute to walk them all.
  That's the point — watch it work through the fleet.
- Try a follow-up: *"Now zoom into [app name] and tell me everything about its current
  state."* This shows how the same tools support both wide and deep investigation.
- Want a different org? Just say *"run the same thing on [other org]"* and it will
  re-scope.
