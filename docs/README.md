# herokumcp documentation

> This folder will hold the polished user-facing documentation starting in Phase 10. Until then, the design docs in the repo root are the source of truth.

## Where to find what you need now

If you're a **user** trying to install or operate the MCP:

- **Quick start, what this is, project status:** [main README](../README.md)
- **The tool catalog:** [TOOLS.md](../TOOLS.md)
- **How the runtime probing works:** [CAPABILITY_PROBES.md](../CAPABILITY_PROBES.md)

If you're a **contributor** or **architect** wanting to understand the design:

- **Overall design:** [ARCHITECTURE.md](../ARCHITECTURE.md)
- **Authentication and token storage:** [AUTH.md](../AUTH.md)
- **The hosted-deployment model:** [DEPLOYMENT.md](../DEPLOYMENT.md)
- **Naming conventions:** [NAMING.md](../NAMING.md)
- **Phased delivery plan:** [ARCHITECTURE.md §15](../ARCHITECTURE.md#15-phased-delivery)
- **Running divergence log:** [notes/divergences.md](../notes/divergences.md)
- **How to contribute:** [CONTRIBUTING.md](../CONTRIBUTING.md)

If you're handling a **security issue:**

- **Disclosure policy:** [SECURITY.md](../SECURITY.md)

## What will live here

When Phase 10 lands, this folder will host:

- `installation.md` — local install + Claude Desktop / Claude Code setup walkthrough
- `deployment.md` — the polished Heroku Button deployment guide for end users
- `configuration.md` — every env var, every CLI flag, every config file option
- `tools.md` — the user-facing tool reference (refined from the design-time TOOLS.md)
- `auth.md` — the user-facing OAuth and sign-in guide (refined from AUTH.md)
- `safety.md` — the confirm + dry_run patterns explained for end users
- `troubleshooting.md` — common errors and their fixes
- `architecture.md` — the internal design reference for contributors
- `runbook.md` — the operator runbook (rotation, revocation, audit, etc.)
- `partner-quickstart.md` — getting started as an add-on partner (after Phase 6)

The current root-level design docs (`ARCHITECTURE.md`, `AUTH.md`, etc.) will be refactored into this structure. They'll grow more user-oriented; their current internal-design-doc tone will move into `architecture.md`.

## Want to help?

Documentation contributions are very welcome, even in this early phase. If you've installed the MCP, set it up against your Heroku account, and found something confusing, that's exactly the kind of feedback that makes the eventual docs good. Open an issue or send a PR.
