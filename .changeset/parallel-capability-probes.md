---
"@heroku-mcp/core": patch
---

Run capability probes concurrently in dependency waves instead of one at a time. The ~21-probe matrix took 5–11s per MCP session, which exceeded remote clients' initialize timeout (claude.ai authorized but never connected). It now takes ~1.4s and produces the same CapabilityResult.
