# OAuth client setup

`@heroku-mcp/http-server` signs your users into **Heroku** to obtain the per-user
API tokens it uses on their behalf. To do that it needs its own Heroku **OAuth
client** — a `client_id` / `client_secret` pair you create once with the Heroku
CLI and hand to the server as config vars.

This guide is the copy-pasteable path from "nothing" to "connected." It teaches
the three CLI commands you need; it does not teach OAuth concepts.

> **The chicken-and-egg.** An OAuth client's redirect URI must exactly match the
> deployed server's callback URL. But you don't know that URL until *after* you
> deploy. So the order is: **create with a placeholder → deploy → update with the
> real URL.** That is the single most common thing people get wrong.

---

## 1. Provision the OAuth client

Create the client with a placeholder redirect URI. You'll fix it in step 3.

```bash
heroku clients:create "Heroku MCP" https://example.com/oauth/callback
```

Example output:

```
Created client Heroku MCP.
=== Heroku MCP
id:            a1b2c3d4-5678-90ab-cdef-1234567890ab
secret:        s3cr3t-9f8e7d6c5b4a39281706f5e4d3c2b1a0
redirect_uri:  https://example.com/oauth/callback
```

Save the `id` and `secret` — you'll paste them into the Button form (or export
them as env vars for a self-hosted deploy). The `secret` is shown only at
creation time; if you lose it, rotate with `heroku clients:rotate <id>`.

> The redirect URI **must** end in `/oauth/callback`. The server serves the
> callback at that exact path; any other path will fail the round-trip.

---

## 2. What the values are used for

These map directly to the config vars in the Button form (and to the env vars a
self-hosted deploy reads):

| OAuth value | Config var | What it does |
|---|---|---|
| `id` | `HEROKUMCP_OAUTH_CLIENT_ID` | Identifies your server to Heroku when it starts the sign-in flow. |
| `secret` | `HEROKUMCP_OAUTH_CLIENT_SECRET` | Authenticates your server to Heroku when it exchanges the auth code for a token. Keep it secret; it's a credential. |
| `redirect_uri` | *(not a config var)* | Lives on the OAuth client itself. Heroku will only redirect back to a URI registered on the client — this is why step 3 matters. |

The server stores no Heroku credentials of its own beyond this client. Each
*user's* token is obtained through the sign-in flow this client enables, then
encrypted at rest under your `HEROKUMCP_MASTER_KEY`.

---

## 3. Update the redirect URI after deploy

Once the app is deployed you know its real URL (e.g.
`https://my-mcp-42.herokuapp.com`, or a custom domain). Point the OAuth client's
redirect URI at the real callback:

```bash
heroku clients:update a1b2c3d4-5678-90ab-cdef-1234567890ab \
  --url https://my-mcp-42.herokuapp.com/oauth/callback
```

Example output:

```
Updated client Heroku MCP.
=== Heroku MCP
id:            a1b2c3d4-5678-90ab-cdef-1234567890ab
redirect_uri:  https://my-mcp-42.herokuapp.com/oauth/callback
```

That's it. Sign in at `https://my-mcp-42.herokuapp.com`, then connect your MCP
client to `https://my-mcp-42.herokuapp.com/mcp`.

> **If the app URL ever changes** — you rename the app, add a custom domain, or
> move providers — re-run `heroku clients:update` with the new
> `/oauth/callback` URL. Also update `HEROKUMCP_PUBLIC_URL` on the app if you set
> it explicitly. Nothing else needs to change; existing user tokens keep working.

---

## Quick reference

```bash
# create (placeholder URI)
heroku clients:create "Heroku MCP" https://example.com/oauth/callback

# list your clients and their redirect URIs
heroku clients

# show one client
heroku clients:info <id>

# update the redirect URI to the real app URL
heroku clients:update <id> --url https://<app>.herokuapp.com/oauth/callback

# rotate the secret if it leaks
heroku clients:rotate <id>
```

---

## Troubleshooting

### "OAuth redirect URI mismatch" / `invalid redirect uri`

The single most common error. The redirect URI registered on the OAuth client
does not exactly match the callback the server sent Heroku. Causes:

- You skipped step 3 — the client still has the `https://example.com/oauth/callback`
  placeholder. Run `heroku clients:update`.
- **Scheme/host/path mismatch:** `http` vs `https`, a trailing slash, a missing
  `/oauth/callback` suffix, or `www.` on one side only. The match is exact.
- **`HEROKUMCP_PUBLIC_URL` disagrees with the OAuth client.** If you set
  `HEROKUMCP_PUBLIC_URL`, the server builds its callback from it — that value's
  origin must match the client's `redirect_uri`. Confirm with
  `heroku clients:info <id>` and `heroku config:get HEROKUMCP_PUBLIC_URL`.

Fix by making the two agree, then retry the sign-in.

### "access denied" after a successful Heroku login

Sign-in worked, but the server's allowlist rejected the account. If you set
`MCP_ALLOWED_EMAILS` or `MCP_ALLOWED_TEAMS`, the signed-in user must be on the
list. Add them, or unset the allowlist to allow anyone with a Heroku account.
The contact shown on the denial page comes from `HEROKUMCP_ADMIN_CONTACT`.

### The client can't discover the OAuth server (Claude Desktop "Add custom connector")

The MCP endpoint advertises its authorization server via
`/.well-known/oauth-protected-resource`, built from `HEROKUMCP_PUBLIC_URL` (or
the incoming request host when unset). If discovery fails behind a proxy or
custom domain, set `HEROKUMCP_PUBLIC_URL` explicitly to the externally-reachable
base URL and redeploy.

### `clients:create` says the name is taken

OAuth client names are unique per account. Pick a different name, or reuse the
existing client: `heroku clients` to list, `heroku clients:info <id>` to read its
current redirect URI.

---

## See also

- [Heroku OAuth reference](https://devcenter.heroku.com/articles/oauth) — the underlying API
- [`heroku clients` CLI](https://devcenter.heroku.com/articles/using-the-cli) — command reference
- [packages/http-server/README.md](../packages/http-server/README.md) — full env-var reference and client-connection details
- [Project README](../README.md) — deploy and architecture overview
