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
and the stapled notarization ticket. Verify DMG integrity with `hdiutil verify`; mount it read-only and verify the enclosed
app with `codesign --verify --deep --strict`, `spctl --assess --type execute`, and
`xcrun stapler validate` before distributing it. The notarization ticket is stapled
to the app, not necessarily to the DMG container.

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

Core releases are built locally and include native CLI binaries, digest-pinned
server/worker/migrate/computer images, and the signed Compose manifest. The protected
local P-256 signing key lives outside Git. Its public key is pinned in
`apps/cli/src/release-signing-key.ts`. `apps/cli/scripts/sign-release.ts` accepts the
key path through `OPENTEAM_RELEASE_SIGNING_KEY_PATH`, verifies that the public key
matches the pin, publishes the signature to Rekor, and verifies each resulting
Sigstore bundle before writing it. The signed payload binds the repository,
version, and artifact SHA256; clients require the pinned key and a verified
transparency-log entry. Historical workflow signatures remain verifiable using
their original issuer and exact release-tag identity.

Build all four images for linux/amd64 and linux/arm64, push immutable image digests,
and render `deploy/compose.yaml` with `scripts/render-release-compose.ts`. Run
`bun --filter @openteam/cli build:release`, then sign the rendered Compose and five
raw CLI binaries with the local signing helper. Publish raw and gzip binaries,
signature bundles and SHA256SUMS together. Test the downloaded signature bundles,
anonymous image pulls, and a fresh public-installer installation before declaring
success. Keep signing keys, registry credentials, and generated notarization material
out of Git and logs.

The tag version must match the CLI, server, worker, computer, desktop, and iOS package
versions and `apps/ios/release.json`. Before cutting a new core release, run the full
repository checks and verify anonymous image pulls and a fresh installation.
