# Releasing OpenBot

The `Release OpenBot` workflow runs for tags shaped like `v1.2.3`. The tag version must exactly
match the CLI, server, worker, computer, and desktop package versions.

Before the first release:

1. Create or claim the `@openbot` organization on npm and grant this repository's publisher access
   to `@openbot/cli`.
2. Add a package-scoped npm granular token as the repository secret `NPM_TOKEN` for the first
   publish. The workflow includes npm provenance from that first release.
3. Ensure the repository is public, or change each new GHCR package to public after its first push.
   End-user installation pulls the four images anonymously, so private package visibility is not a
   supported release state.
4. Configure signed desktop release secrets: `WINDOWS_CSC_LINK`,
   `WINDOWS_CSC_KEY_PASSWORD`, `MACOS_CSC_LINK`, `MACOS_CSC_KEY_PASSWORD`, `MACOS_CSC_NAME`,
   `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`.

The workflow then:

- runs the architecture checks plus CLI, server, worker, computer, and desktop typechecks/tests;
- publishes version-pinned `linux/amd64` and `linux/arm64` server, worker, migration, and computer
  images to GHCR from digest-pinned build stages, with provenance and SBOM attestations;
- renders `openbot-compose.yaml` with the exact multi-architecture digest of every OpenBot image;
- signs the Compose bundle and Linux AppImage with the workflow's Sigstore identity, publishes
  GitHub build-provenance attestations, and attaches the signatures plus `SHA256SUMS`;
- attaches signed Windows, signed and notarized macOS, and Linux desktop installers plus their
  electron-updater metadata;
- publishes the matching `@openbot/cli` version to npm.

The CLI accepts only a Compose signature issued to this repository's `release.yml` workflow and the
matching version tag. The checksum remains a fast corruption check; the Sigstore bundle establishes
publisher identity and transparency-log inclusion. Release Actions are pinned to immutable commit
SHAs and permissions are scoped per job. Dependabot should keep those pinned revisions current.

Create a release only after the full repository check passes:

```sh
bun run check
git tag v0.1.0
git push origin v0.1.0
```

After the first release, verify anonymous image pulls and the public install command from a machine
that is not authenticated to GitHub or npm. Then configure `release.yml` as the package's npm
trusted publisher, remove `NODE_AUTH_TOKEN` from the npm job, and revoke `NPM_TOKEN`; the job already
has the required OIDC permission and npm will continue publishing provenance automatically.
