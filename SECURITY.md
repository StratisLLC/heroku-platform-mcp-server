# Security Policy

We take the security of this project seriously, particularly given that it brokers access to live Heroku accounts and handles authentication tokens.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, email **salesforce@stratisglobal.com** with:

- A description of the issue
- Steps to reproduce
- The version(s) of `@heroku-mcp/*` packages affected (if known)
- The potential impact as you understand it
- Any suggested fix or mitigation

You should receive an initial response within 72 hours. We'll work with you to understand the issue, develop a fix, and coordinate disclosure.

If you don't get a response within that window, please follow up — emails do occasionally get lost.

## What's in scope

Issues we particularly want to know about:

- Token leakage (in logs, error messages, stack traces, audit log, on-disk caches, etc.)
- Bypasses of the `confirm` requirement for destructive operations
- Bypasses of the capability-probing tier gates
- SQL injection, command injection, or other code execution paths
- Cryptographic mistakes in the envelope encryption design (when Phase 4 ships)
- OAuth flow vulnerabilities (CSRF, code-injection, state-validation bypass, etc., when Phase 4 ships)
- Privilege escalation between users in a multi-user deployment (when Phase 4 ships)
- Any path by which a third party could cause the MCP to issue API calls against a user's Heroku account without authorization

## What's out of scope

- Misuse of the MCP by a user who has legitimate access to the configured token (this is a feature of the system; if you can already make Heroku API calls with the token, you can make Heroku API calls with the token)
- Denial-of-service through Heroku rate limits (we surface these; we can't prevent users from hitting their own quota)
- Issues in upstream dependencies that have not been disclosed to those dependencies first
- Social engineering of project maintainers or users
- Theoretical attacks requiring physical access to the user's machine
- Issues in Heroku itself — please report those to [Heroku's security team](https://www.heroku.com/policy/security)

## Disclosure timeline

Our default disclosure window is **90 days** from initial report:

- Days 1–60: investigate, develop fix, test
- Days 60–80: release fix, coordinate with downstream consumers
- Days 80–90: public disclosure via GitHub Security Advisory and CHANGELOG entry

We'll move faster if the issue is actively exploited or affects pre-deployment infrastructure (e.g. token storage); we may request more time for issues that require architectural changes.

## Acknowledgment

We're happy to credit reporters in the Security Advisory and CHANGELOG unless you'd prefer to remain anonymous. Just let us know your preference when reporting.

## Encryption

If you'd like to encrypt your report, request our PGP key in your initial email and we'll send it back before you share details.

---

Thanks for helping keep herokumcp safe.
