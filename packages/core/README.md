# @heroku-mcp/core

Shared library powering [herokumcp](https://github.com/StratisLLC/heroku-platform-mcp-server): the HTTP client, schema discovery, capability probing, encrypted token storage, structured error types, audit logging, and secret redaction used by both `@heroku-mcp/platform` and `@heroku-mcp/partner`.

> This is a workspace-internal package. Most users will install `@heroku-mcp/platform` instead, which depends on this library. Direct consumers of `@heroku-mcp/core` should read [the architecture doc](https://github.com/StratisLLC/heroku-platform-mcp-server/blob/main/ARCHITECTURE.md) for context.

## Install

```bash
npm install @heroku-mcp/core
```

Requires Node ≥ 20.

## What's in this package

```
HerokuClient        — fetch wrapper with retry, ETag caching, rate-limit
                      awareness, ratelimit-remaining tracking, audit logging
fetchSchema         — fetch and cache the Heroku Platform API JSON Schema
runProber           — execute the capability probe matrix against a token
createTokenStore    — TokenStore factory (keychain → file → in-memory)
ConfirmationRequiredError, ConfirmationMismatchError, assertConfirm
                    — destructive-op confirmation helpers
buildDryRunResponse — structured preview for mutating tools that haven't
                      executed
HerokuApiError, AuthError, ForbiddenError, RateLimitError, ...
                    — typed error hierarchy mirroring Heroku's response shapes
redact              — recursive secret redaction for logs and error messages
appendAuditEntry    — JSONL audit log with daily rotation
```

## Example

```ts
import {
  createHerokuClient,
  runProber,
  createTokenStore,
  PROBE_MATRIX,
} from '@heroku-mcp/core';

const tokens = await createTokenStore();
const token = await tokens.get({ scope: 'platform-user', userId: 'me' });
if (!token) throw new Error('No token configured.');

const client = createHerokuClient({ token });

// Discover what this token can do.
const capabilities = await runProber({ client, probes: PROBE_MATRIX });
console.log(capabilities.tiers);
// → { account: { available: true }, apps: { available: true },
//     teams: { available: true }, enterprise: { available: false }, ... }

// Make an authenticated request.
const account = await client.get('/account');
console.log(account.data.email);
```

## Key design points

- **All requests go through the `HerokuClient`**, which applies redaction, rate-limit tracking, ETag caching, and audit logging consistently. There is no shortcut path that bypasses these.
- **TokenStore has three backends** chosen automatically by the bootstrap layer: OS keychain (via `keytar`) for stdio installations, AES-256-GCM encrypted file for stdio installs without keychain access, and Postgres-backed envelope encryption (Phase 4+) for hosted deployments.
- **The probe matrix is data, not code.** Probes are declared in `probes.ts` and the prober interprets them. Adding a capability tier means adding a probe definition, not writing a new module.
- **Errors are typed by kind** (`auth`, `forbidden`, `rate_limit`, `confirmation`, etc.) so the host can react programmatically without parsing strings.

## Tests

```bash
pnpm test              # 242 unit tests
pnpm test:integration  # 2 live tests against api.heroku.com (requires HEROKUMCP_TEST_TOKEN)
```

## Documentation

- [Architecture](https://github.com/StratisLLC/heroku-platform-mcp-server/blob/main/ARCHITECTURE.md) — overall design
- [Capability probes](https://github.com/StratisLLC/heroku-platform-mcp-server/blob/main/CAPABILITY_PROBES.md) — the probe matrix
- [Auth](https://github.com/StratisLLC/heroku-platform-mcp-server/blob/main/AUTH.md) — token storage and OAuth design

## License

[Apache-2.0](https://github.com/StratisLLC/heroku-platform-mcp-server/blob/main/LICENSE).
