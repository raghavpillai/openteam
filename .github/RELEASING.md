# Releasing OpenTeam locally

Build releases on the appropriate local machine. Tag pushes do not run a release
workflow. GitHub Releases remains the download host used by `openteam.so/download`
and the install scripts; uploading locally built artifacts does not require GitHub
Actions. The CLI installer workflow runs tests only.

## macOS desktop

Build the requested source revision in an isolated checkout so unrelated working-tree
changes cannot enter an installer. For an existing release, use its exact tag commit;
do not move the tag just to add a missing installer. Use the Bun version pinned in
root `package.json`, install with `bun install --frozen-lockfile`, and generate the
database client with `bun run db:generate`.

From `apps/desktop`, run `bun run typecheck` and `bun run package:mac-release`.
The signed release script requires a Developer ID Application identity selected by
`CSC_NAME` and notarization credentials. `CSC_LINK` and `CSC_KEY_PASSWORD` can import
a protected P12 into a temporary Keychain. Supply notarization through one complete
credential mode:

- `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`.
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`.
- `APPLE_KEYCHAIN_PROFILE` (and the existing corresponding Keychain credentials).

Keep credentials outside the repository, pass them through the process environment,
and never put their values in logs. Keep the signing identity consistent across
releases. The release command enables hardened runtime, notarizes the app, checks
package budgets, and verifies Developer ID signatures, entitlements, Gatekeeper,
and the stapled notarization ticket. Verify the DMG with `hdiutil verify` and
`xcrun stapler validate` before distributing it.

`package:mac-local` makes an ad-hoc build for testing; use `package:mac-release`
for public installers. The maintainer's reusable local release skill lives in a
private, gitignored `.agents/skills/openteam-macos-release/` folder.

## Publish artifacts

Upload the verified DMG, ZIP, blockmaps, and `latest-mac.yml` from
`apps/desktop/release/` to the intended release using `gh release upload <tag> <files>`.
Do not replace existing assets unless that replacement is intended. Preserve other
platforms' entries in `DESKTOP_SHA256SUMS`, add the hashes of the uploaded macOS files,
and upload the merged checksum file. Download the published DMG and verify its hash.

The download page selects `OpenTeam-<version>-mac-arm64.dmg` from the latest published
GitHub release and caches lookups for five minutes. Verify the download page resolves
the installer after publication. A local build alone does not make a public download.

## Core artifacts and trust

Existing releases include native CLI binaries, digest-pinned server/worker/migrate/
computer images, and the signed Compose manifest. Preserve these assets and their
checksums when adding a desktop installer. The CLI verifies Compose signatures against
the historical `release.yml` GitHub-workflow identity. Removing release automation does
not change that verification policy or invalidate published artifacts. Publishing new
core artifacts locally requires a separately reviewed signing identity and verifier
change; do not disable verification to reuse the macOS publishing procedure.

The tag version must match the CLI, server, worker, computer, desktop, and iOS package
versions and `apps/ios/release.json`. Before cutting a new core release, run the full
repository checks and verify anonymous image pulls and a fresh installation.
