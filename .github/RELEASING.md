# Releasing OpenTeam

The `Release OpenTeam` workflow runs for tags shaped like `v1.2.3`. The tag version must exactly
match the CLI, server, worker, computer, and desktop package versions.

## What a release produces

Users install with `curl -fsSL https://openteam.so/install | sh` (or `install.ps1` on Windows).
That script downloads a native `openteam` binary from the latest GitHub release and verifies it
against `SHA256SUMS`, so the release itself is the distribution channel. npm is optional.

The workflow:

1. **validate**: architecture checks plus CLI, server, worker, computer, and desktop
   typechecks and tests, after generating the database client.
2. **images**: version-pinned `linux/amd64` and `linux/arm64` server, worker, migrate, and
   computer images pushed to GHCR from digest-pinned build stages, with provenance and SBOM
   attestations.
3. **github-release**: renders `openteam-compose.yaml` with the exact multi-architecture digest of
   every image, signs it with the workflow's Sigstore identity, builds the native CLI binaries
   (`openteam-darwin-arm64`, `openteam-darwin-x64`, `openteam-linux-arm64`, `openteam-linux-x64`,
   `openteam-windows-x64.exe`), writes `SHA256SUMS` over all of them, attests them, and creates
   the GitHub release. This job does not wait for desktop builds, so the server release is never
   blocked by an installer.
4. **desktop-linux / desktop-windows / desktop-macos**: build the Electron installers. Linux
   always builds. Windows builds only when `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD` are
   set. macOS builds only when `MACOS_CSC_LINK`, `MACOS_CSC_KEY_PASSWORD`, `MACOS_CSC_NAME`,
   `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` are all set. A platform with
   missing credentials is skipped, not failed.
5. **desktop-release**: signs the Linux AppImage with Sigstore, writes `DESKTOP_SHA256SUMS`,
   attests, and uploads whatever installers were built plus their electron-updater metadata to the
   same release. The download page at `openteam.so/download` reads the release through the GitHub
   API and offers only the builds that exist.
6. **npm**: publishes `@openteam/cli` with provenance when `NPM_TOKEN` is set, and exits
   successfully with a notice when it is not.

## Before the first release

1. Make the repository public, or make each GHCR package public after its first push. Installs
   pull the four images anonymously, so private packages are not a supported release state.
2. Optional: add the desktop signing secrets listed above for the platforms you want installers
   for. Without them the release ships the Linux AppImage only.
3. Optional: create the `@openteam` npm organization, grant this repository publish access to
   `@openteam/cli`, and add a package-scoped granular token as `NPM_TOKEN`.

## Cutting a release

Only after the full repository check passes:

```sh
bun run check
git tag v0.1.0
git push origin v0.1.0
```

Afterwards, from a machine that is not signed in to GitHub, verify anonymous image pulls and run
the public install command end to end. If you publish to npm, switch `release.yml` to npm trusted
publishing, remove `NODE_AUTH_TOKEN` from the npm job, and revoke `NPM_TOKEN`; the job already has
the OIDC permission and provenance continues automatically.

## Verification model

The CLI accepts a Compose file only when its Sigstore signature was issued to this repository's
`release.yml` workflow for the matching version tag. `SHA256SUMS` is a fast corruption check; the
Sigstore bundle establishes publisher identity and transparency-log inclusion. Release Actions are
pinned to immutable commit SHAs with permissions scoped per job; Dependabot keeps those pins
current.
