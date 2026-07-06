# Releasing

`@heroku-mcp/*` packages are published to npm **only** by the
[`Publish` GitHub Actions workflow](.github/workflows/publish.yml). Publishing
from CI is what produces **npm provenance** — a Sigstore attestation (via GitHub
OIDC / `id-token: write`) that cryptographically links each published tarball to
the exact source commit and workflow run that built it.

> [!WARNING]
> **Never publish from a local machine.** Do **not** run `pnpm changeset publish`,
> `pnpm publish`, or `npm publish` on your workstation. A local publish:
> - carries **no provenance** (there is no OIDC identity to attest with), and
> - **permanently claims the version number** — npm will not let CI re-publish
>   that version afterward, so the released tarball is stuck without an attestation.
>
> If a version has already been published locally, provenance for that version
> cannot be added retroactively. Bump to a new version and release it through CI.

## The one supported flow

### 1. Open a changesets "version" PR

Apply the queued changesets to bump versions and update changelogs:

```bash
pnpm changeset version
git commit -am "chore: version packages"
```

Open a PR with that commit and merge it. This step is deliberately a reviewed PR
— it only edits `package.json` versions and `CHANGELOG.md` files; it publishes
nothing.

### 2. Tag the release and push the tag

After the version PR is merged, tag `main` with an **umbrella `vX.Y.Z` tag** and
push it:

```bash
git checkout main && git pull
git tag v1.3.5
git push origin v1.3.5
```

The [`Publish` workflow](.github/workflows/publish.yml) triggers on tags matching
`v*.*.*`. Use the single umbrella `vX.Y.Z` form — per-package tags such as
`core-vX.Y.Z` or `platform-vX.Y.Z` do **not** match the trigger and will not
publish anything.

### 3. CI builds, tests, and publishes with provenance

The workflow checks out the tag, installs with `--frozen-lockfile`, builds, runs
the test suite, then runs:

```bash
pnpm -r publish --access public --no-git-checks --provenance
```

with `NPM_CONFIG_PROVENANCE: 'true'` and `NODE_AUTH_TOKEN` from the `NPM_TOKEN`
secret. Only packages whose version is not already on npm are published, so
re-running the tag is safe. The build + test steps gate the irreversible publish,
so a broken commit can never reach npm.

### 4. Verify provenance

On each package's npmjs.com page, confirm the **Provenance** section shows the
source commit and the `Publish` workflow. From the CLI:

```bash
npm view @heroku-mcp/http-server --json | jq '.dist'
```

A provenance-attested release links back to this repository and the workflow run.

## Required repository secret

The `Publish` workflow authenticates to npm with a repository secret named
`NPM_TOKEN` (Settings → Secrets and variables → Actions). It must be an npm
**Automation** token with publish rights to the `@heroku-mcp` org — automation
tokens are the only kind that bypass publish-time 2FA in CI. Never commit a token
or paste one into a workflow file; only the secret reference
`${{ secrets.NPM_TOKEN }}` belongs in [`publish.yml`](.github/workflows/publish.yml).

## Notes

- Packages published **before** this CI-only release process may lack provenance
  attestation. Provenance applies to releases cut through the `Publish` workflow
  from this point forward; historical tarballs cannot be attested retroactively.
- Versions are independent across the seven packages (changesets, not lockstep).
  A single `vX.Y.Z` tag publishes whichever packages the merged version PR bumped.
