# Releasing OpenTeam locally

Build releases on the appropriate local machine. Tag pushes do not run a release
workflow. GitHub Releases remains the download host used by `openteam.so/download`
and the install scripts; uploading locally built artifacts does not require GitHub
Actions. The CLI installer workflow runs tests only.

## v0.0.15 release preparation

Prepare v0.0.15 from `c2b9b6fcdcdad03fd079542425217b6a15b56e0a`, with
v0.0.14 (`4194501779e7d593b55982399bd225d04e7f89a2`) as the published baseline.
Keep the root and all workspace package versions, `bun.lock` workspace versions,
and `apps/ios/release.json` at `0.0.15`. Dependency resolutions stay unchanged.

This candidate includes eight merged PRs since that baseline: #245, #246, #247,
#248, #249, #252, #253, and #254. They improve iOS Siri/Spotlight switch contrast,
Duo sidebar selection and contextual controls, persistent app shortcuts, the idle
chat screen, search and history navigation, settings sheets, attachment tray motion,
bot deletion, activity indicators, and notification opening on iOS and desktop.
Review the draft notes in ignored `output/release-v0.0.15/release-notes.md` before
publication. The existing CLI false `STARTING` status report is not established as
fixed by this release.

The parent's read-only App Store Connect inventory on November 7, 2026 at 23:19 UTC
found build `65` unused in both builds and build uploads for `dev.openbot.mobile`
(app `6807991964`); this candidate selects it. Source metadata does not reserve a
build number or establish an upload or public availability.

The separate typed public-build verification at 23:20:54 UTC confirmed version
`0.0.14 (64)` is VALID, unexpired, APPROVED, externally IN_BETA_TESTING, and a member
of the existing public TestFlight group. The checked-in update notice advances to
that verified public build; the production notice changes when the site is deployed.
Build 65 remains unadvertised. Preserve committed native renderer and noVNC bundle
bytes for this metadata-only project regeneration; this candidate has no VNC source
changes. Full QA, artifact builds and installed-artifact verification are separate
release gates, including physical-device APNs and Siri checks.

## Preparation checks

Before every iOS upload, query App Store Connect builds **and build uploads**
read-only, including unfinished uploads, and choose an unused build number. Recheck
immediately before uploading because source metadata does not reserve it on Apple.
Update `apps/ios/release.json`, then regenerate the checked-in Xcode project with
`python3 apps/ios/scripts/generate-project.py`. Keep signing credentials outside Git
and logs. For a public iOS update notice, verify the exact version/build is valid,
unexpired, approved and available in the public TestFlight group before updating
`apps/landing/public/ios-update.json` and deploying the site.

Record the tested SHA, worktree, tool versions and focused metadata, generated
configuration, documentation rendering/link checks and tests. Keep these results
separate from the full repository gate, desktop interaction QA, native device QA,
and installed-artifact verification. Review those broader checks before promotion.
Siri AI preview reasoning and app-skill selection require supported physical hardware,
preview access, and a development-signed or internal TestFlight build; simulator
checks and external public TestFlight do not establish that behavior. See the
[iOS build and preview requirements](../apps/ios/README.md#siri-ai-preview-and-app-skills).

A version bump and passing source checks do not establish installer quality,
device behavior, or TestFlight availability. Candidate preparation does not publish
a tag, GitHub release, installer, container, or TestFlight build. Keep public update
feeds at verified releases until new artifacts are available and verified.

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
