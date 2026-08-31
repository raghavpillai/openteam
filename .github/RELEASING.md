# Releasing OpenBot

The `Release OpenBot` workflow runs for tags shaped like `v1.2.3`. The tag version must exactly
match `apps/cli/package.json`.

Before the first release:

1. Create or claim the `@openbot` organization on npm and grant this repository's publisher access
   to `@openbot/cli`.
2. Add an npm automation token as the repository secret `NPM_TOKEN`, or migrate the publish job to
   npm trusted publishing after the package has been created.
3. Ensure the repository is public, or change each new GHCR package to public after its first push.
   End-user installation pulls the four images anonymously, so private package visibility is not a
   supported release state.

The workflow then:

- validates, tests, and builds the CLI;
- publishes version-pinned `linux/amd64` and `linux/arm64` server, worker, migration, and computer
  images to GHCR with provenance and SBOM attestations;
- attaches `openbot-compose.yaml` and `SHA256SUMS` to the GitHub Release;
- publishes the matching `@openbot/cli` version to npm.

Create a release only after the full repository check passes:

```sh
bun run check
git tag v0.1.0
git push origin v0.1.0
```

After the first release, verify anonymous image pulls and the public install command from a machine
that is not authenticated to GitHub or npm.
