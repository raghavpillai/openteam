# Releasing OpenTeam

The `Release OpenTeam` workflow runs for tags shaped like `v1.2.3`. The tag version must exactly
match the CLI, server, worker, computer, desktop, and mobile package versions plus the Expo app
version. Releases are all-or-nothing: the public GitHub release stays unavailable unless every
desktop installer is signed and the matching iPhone build reaches TestFlight.

## What a release produces

Users install with `curl -fsSL https://openteam.so/install | sh` (or `install.ps1` on Windows).
That script downloads a native `openteam` binary from the latest GitHub release and verifies it
against `SHA256SUMS`, so the release itself is the distribution channel. Node.js, Bun, and npm are
not required on an end-user machine.

The workflow:

1. **validate**: architecture checks plus CLI, server, worker, computer, desktop, and mobile
   typechecks and tests, after generating the database client.
2. **images**: version-pinned `linux/amd64` and `linux/arm64` server, worker, migrate, and
   computer images pushed to GHCR from digest-pinned build stages, with provenance and SBOM
   attestations.
3. **desktop-linux / desktop-windows / desktop-macos**: build the Electron installers. Linux
   always builds. Windows and macOS signing credentials are mandatory; missing credentials fail
   the release. The macOS job signs and notarizes its artifacts.
4. **mobile-ios**: builds the matching iPhone app with EAS and submits that exact build to App
   Store Connect for TestFlight. `EXPO_TOKEN` and current EAS signing/submission credentials are
   mandatory.
5. **github-release**: after every image, desktop, and mobile job succeeds, renders
   `openteam-compose.yaml` with the exact image digests, signs the Compose bundle and Linux
   AppImage with the workflow's Sigstore identity, writes CLI and desktop checksums, attests all
   artifacts, uploads every installer, and publishes the release.

## Before the first release

1. Make the repository public, or make each GHCR package public after its first push. Installs
   pull the four images anonymously, so private packages are not a supported release state.
2. Add `WINDOWS_CSC_LINK`, `WINDOWS_CSC_KEY_PASSWORD`, `MACOS_CSC_LINK`,
   `MACOS_CSC_KEY_PASSWORD`, `MACOS_CSC_NAME`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and
   `APPLE_TEAM_ID` as repository secrets.
3. Create an Expo access token for the `zzenn` EAS project and add it as the repository secret
   `EXPO_TOKEN`. Confirm that the App Store Connect app, distribution certificate, provisioning
   profile, and production submit credentials are current in EAS. The workflow creates an internal
   TestFlight group when needed and waits for the exact build's submission to finish.
4. In App Store Connect, add the submitted build to an external TestFlight group when a public beta
   is intended. A public TestFlight link requires Apple's beta review.

## Cutting a release

Only after the full repository check passes:

```sh
bun run check
git tag v1.2.3
git push origin v1.2.3
```

After the first release, verify anonymous image pulls and the public install command from a machine
that is not authenticated to GitHub or EAS. Install each desktop artifact on a clean OS, confirm
its platform signature, and verify that the TestFlight build can sign in to a newly installed
server before announcing the release.

## Verification model

The CLI accepts a Compose file only when its Sigstore signature was issued to this repository's
`release.yml` workflow for the matching version tag. `SHA256SUMS` is a fast corruption check; the
Sigstore bundle establishes publisher identity and transparency-log inclusion. Release Actions are
pinned to immutable commit SHAs with permissions scoped per job; Dependabot keeps those pins
current.
